"""Offline cross-checks for the static site: element ids used by app.js exist
in index.html, and every dynamic-string sink avoids innerHTML."""
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
HTML = (ROOT / 'index.html').read_text()
JS = (ROOT / 'app.js').read_text()


class WebsiteTests(unittest.TestCase):
    def test_every_dom_id_referenced_by_js_exists(self):
        ids = set(re.findall(r'id="([^"]+)"', HTML))
        used = set(re.findall(r"\$\('([^']+)'\)", JS))
        used |= set(re.findall(r"getElementById\('([^']+)'\)", JS))
        missing = sorted(used - ids)
        self.assertEqual(missing, [], f'app.js references missing ids: {missing}')

    def test_no_innerhtml_with_dynamic_content(self):
        # No HTML-string sinks at all: chat text, nicknames, and model
        # output are untrusted and must only flow through textContent.
        self.assertNotRegex(JS, r'\.innerHTML\s*=')
        self.assertNotRegex(JS, r'insertAdjacentHTML')
        self.assertNotRegex(JS, r'document\.write')

    def test_all_script_sources_resolve_locally(self):
        for src in re.findall(r'<script src="([^"]+)"', HTML):
            if src.startswith('http'):
                continue  # hls.js CDN, matches the existing site pattern
            self.assertTrue((ROOT / src).exists(), f'missing local script {src}')

    def test_stylesheets_and_api_routes_exist(self):
        self.assertIn('app.css', HTML)
        self.assertTrue((ROOT / 'app.css').exists())
        self.assertTrue((ROOT / 'api' / 'state.js').exists())

    def test_deep_link_modes_are_handled(self):
        for mode in ['arena', 'grid', 'play', 'focus', 'cinder', 'vex', 'mira', 'tally']:
            self.assertIn(f"'{mode}'", JS)


if __name__ == '__main__':
    unittest.main()
