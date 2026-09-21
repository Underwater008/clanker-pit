#!/usr/bin/env python3
"""Downloads a Minecraft Java client (jar, libraries, natives, assets) for headless use.
Runs on the pod. Idempotent: existing files are skipped.
Usage: python3 client_setup.py [version]"""
import concurrent.futures as cf
import hashlib
import json
import os
import sys
import urllib.request
import zipfile

VERSION = sys.argv[1] if len(sys.argv) > 1 else "1.21.1"
ROOT = "/workspace/arena/client"
LIB_DIR = f"{ROOT}/libraries"
NATIVES_DIR = f"{ROOT}/natives"
ASSETS_DIR = f"{ROOT}/assets"
UA = {"User-Agent": "clankerpit-capture/1.0"}

os.makedirs(LIB_DIR, exist_ok=True)
os.makedirs(NATIVES_DIR, exist_ok=True)
os.makedirs(f"{ASSETS_DIR}/indexes", exist_ok=True)
os.makedirs(f"{ASSETS_DIR}/objects", exist_ok=True)


def fetch(url, dest=None, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req) as r:
        data = r.read()
    if dest:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        return dest
    return data if binary else json.loads(data)


print(f"==> resolving version {VERSION}")
manifest = fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
vmeta_url = next(v["url"] for v in manifest["versions"] if v["id"] == VERSION)
vjson = fetch(vmeta_url)

print("==> client jar")
client_jar = f"{ROOT}/client.jar"
if not os.path.exists(client_jar):
    fetch(vjson["downloads"]["client"]["url"], client_jar)
print(f"    {os.path.getsize(client_jar) / 1e6:.1f} MB")


def lib_allowed(lib):
    rules = lib.get("rules")
    if not rules:
        return True
    allowed = False
    for rule in rules:
        osname = (rule.get("os") or {}).get("name")
        if rule["action"] == "allow" and (osname in (None, "linux")):
            allowed = True
        if rule["action"] == "disallow" and osname == "linux":
            allowed = False
    return allowed


print("==> libraries")
classpath = []
native_urls = []
for lib in vjson["libraries"]:
    if not lib_allowed(lib):
        continue
    dl = lib["downloads"]
    art = dl.get("artifact")
    if art:
        path = f"{LIB_DIR}/{art['path']}"
        if not os.path.exists(path):
            fetch(art["url"], path)
        classpath.append(path)
    natives = lib.get("natives", {})
    if "linux" in natives:
        classifier = natives["linux"]
        nat = dl["classifiers"].get(classifier)
        if nat:
            native_urls.append((nat["url"], nat["path"]))

with cf.ThreadPoolExecutor(16) as ex:
    futs = []
    for url, path in native_urls:
        dest = f"{LIB_DIR}/{path}"
        if not os.path.exists(dest):
            futs.append(ex.submit(fetch, url, dest))
    for f in cf.as_completed(futs):
        f.result()

print("==> extracting natives")
for _, path in native_urls:
    with zipfile.ZipFile(f"{LIB_DIR}/{path}") as z:
        for name in z.namelist():
            if name.startswith("META-INF") or name.endswith((".git", ".sha1")):
                continue
            z.extract(name, NATIVES_DIR)

print("==> assets index")
idx = vjson["assetIndex"]
idx_path = f"{ASSETS_DIR}/indexes/{idx['id']}.json"
if not os.path.exists(idx_path):
    fetch(idx["url"], idx_path)
objects = json.load(open(idx_path))["objects"]
print(f"    {len(objects)} objects")

needed = []
for name, meta in objects.items():
    h = meta["hash"]
    dest = f"{ASSETS_DIR}/objects/{h[:2]}/{h}"
    if not os.path.exists(dest):
        needed.append((h, dest))
print(f"    {len(needed)} to download")


def grab(hdest):
    h, dest = hdest
    fetch(f"https://resources.download.minecraft.net/{h[:2]}/{h}", dest)


if needed:
    with cf.ThreadPoolExecutor(32) as ex:
        done = 0
        for _ in ex.map(grab, needed):
            done += 1
            if done % 500 == 0:
                print(f"    {done}/{len(needed)}")

classpath.append(client_jar)
with open(f"{ROOT}/classpath.txt", "w") as f:
    f.write(":".join(classpath))

meta = {
    "version": VERSION,
    "assetIndex": idx["id"],
    "mainClass": vjson["mainClass"],
}
json.dump(meta, open(f"{ROOT}/meta.json", "w"), indent=2)
print(f"==> done. main={meta['mainClass']} assets={idx['id']} libs={len(classpath)}")
