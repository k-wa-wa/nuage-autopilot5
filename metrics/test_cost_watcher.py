#!/usr/bin/env python3
"""
cost_watcher.py の単体テスト。
"""

import json
import os
import sys
import tempfile
import unittest
from io import BytesIO, StringIO
from unittest import mock
import urllib.error

# テスト対象のインポート
sys.path.insert(0, os.path.dirname(__file__))

import cost_watcher as cw_mod
from cost_watcher import (
    CheckResult,
    CompositePriceSource,
    CostWatcher,
    FilePriceSource,
    HttpJsonPriceSource,
    RateFieldMismatch,
    StaticPriceSource,
    build_parser,
    main,
)


class TestCostWatcher(unittest.TestCase):
    """CostWatcher の単価比較ロジックのテスト"""

    def test_identical_catalogs(self):
        rates = {
            "model-a": {"input": 1.0, "output": 2.0},
            "model-b": {"input": 0.5, "output": 1.5, "cache_read": 0.05},
        }
        catalog = {
            "model-a": {"input": 1.0, "output": 2.0},
            "model-b": {"input": 0.5, "output": 1.5, "cache_read": 0.05},
        }
        watcher = CostWatcher(rates=rates, catalog=catalog)
        res = watcher.check()

        self.assertTrue(res.ok)
        self.assertEqual(len(res.mismatches), 0)
        self.assertEqual(res.missing_in_rates, [])
        self.assertEqual(res.missing_in_catalog, [])

    def test_price_mismatches_detected(self):
        rates = {
            "model-a": {"input": 1.0, "output": 2.0, "cache_read": 0.1},
        }
        catalog = {
            "model-a": {"input": 1.2, "output": 2.0, "cache_read": 0.08},
        }
        watcher = CostWatcher(rates=rates, catalog=catalog)
        res = watcher.check()

        self.assertFalse(res.ok)
        self.assertEqual(len(res.mismatches), 2)

        input_diff = next(m for m in res.mismatches if m.field == "input")
        self.assertEqual(input_diff.model, "model-a")
        self.assertEqual(input_diff.rates_value, 1.0)
        self.assertEqual(input_diff.catalog_value, 1.2)
        self.assertAlmostEqual(input_diff.diff, -0.2, places=5)

        cache_diff = next(m for m in res.mismatches if m.field == "cache_read")
        self.assertEqual(cache_diff.rates_value, 0.1)
        self.assertEqual(cache_diff.catalog_value, 0.08)
        self.assertAlmostEqual(cache_diff.diff, 0.02, places=5)

    def test_tolerance_threshold(self):
        rates = {"model-a": {"input": 1.0000001, "output": 2.0}}
        catalog = {"model-a": {"input": 1.0, "output": 2.0}}

        # tolerance 1e-5 であれば誤差範囲内としてパス
        watcher_tolerant = CostWatcher(rates=rates, catalog=catalog, tolerance=1e-5)
        self.assertTrue(watcher_tolerant.check().ok)

        # tolerance 1e-8 であれば誤差を超えて検知
        watcher_strict = CostWatcher(rates=rates, catalog=catalog, tolerance=1e-8)
        self.assertFalse(watcher_strict.check().ok)

    def test_missing_models(self):
        rates = {
            "model-a": {"input": 1.0, "output": 2.0},
            "custom-local-model": {"input": 0.1, "output": 0.2},
        }
        catalog = {
            "model-a": {"input": 1.0, "output": 2.0},
            "new-official-model": {"input": 3.0, "output": 6.0},
        }

        # 既定: カタログ外モデルも不整合と判定
        watcher = CostWatcher(rates=rates, catalog=catalog)
        res = watcher.check()
        self.assertFalse(res.ok)
        self.assertEqual(res.missing_in_rates, ["new-official-model"])
        self.assertEqual(res.missing_in_catalog, ["custom-local-model"])

        # ignore_missing_in_catalog=True の場合: missing_in_rates が無ければ OK
        watcher_ignore = CostWatcher(
            rates=rates,
            catalog=catalog,
            ignore_missing_in_catalog=True,
        )
        res_ignore = watcher_ignore.check()
        self.assertFalse(res_ignore.ok)  # new-official-model が rates に無いため False

        # missing_in_rates を無くした場合
        rates_with_official = dict(rates)
        rates_with_official["new-official-model"] = {"input": 3.0, "output": 6.0}
        watcher_ok = CostWatcher(
            rates=rates_with_official,
            catalog=catalog,
            ignore_missing_in_catalog=True,
        )
        res_ok = watcher_ok.check()
        self.assertTrue(res_ok.ok)
        self.assertEqual(res_ok.missing_in_catalog, ["custom-local-model"])

    def test_missing_field_in_rates_or_catalog(self):
        rates = {"model-a": {"input": 1.0, "output": 2.0, "cache_creation": 1.25}}
        catalog = {"model-a": {"input": 1.0, "output": 2.0}}  # cache_creation なし

        watcher = CostWatcher(rates=rates, catalog=catalog)
        res = watcher.check()
        self.assertFalse(res.ok)
        self.assertEqual(len(res.mismatches), 1)
        self.assertEqual(res.mismatches[0].field, "cache_creation")
        self.assertEqual(res.mismatches[0].rates_value, 1.25)
        self.assertEqual(res.mismatches[0].catalog_value, 0.0)

    def test_result_to_dict_and_format_report(self):
        rates = {"model-a": {"input": 1.0, "output": 2.0}}
        catalog = {
            "model-a": {"input": 1.5, "output": 2.0},
            "model-b": {"input": 0.5, "output": 1.0},
        }
        res = CostWatcher(rates=rates, catalog=catalog).check()
        d = res.to_dict()

        self.assertFalse(d["ok"])
        self.assertEqual(d["mismatch_count"], 1)
        self.assertIn("model-b", d["missing_in_rates"])

        report = res.format_report()
        self.assertIn("警告/異常", report)
        self.assertIn("model-a", report)
        self.assertIn("model-b", report)


class TestPriceSources(unittest.TestCase):
    """各 PriceSource の動作テスト"""

    def test_static_price_source(self):
        catalog = {"model-x": {"input": 1.0, "output": 2.0}}
        src = StaticPriceSource(catalog)
        self.assertEqual(src.fetch_catalog(), catalog)

    def test_file_price_source_yaml_and_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = os.path.join(tmpdir, "test_rates.yaml")
            with open(yaml_path, "w", encoding="utf-8") as f:
                f.write("model-y:\n  input: 2.50\n  output: 10.00\n")

            json_path = os.path.join(tmpdir, "test_rates.json")
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump({"model-z": {"input": 0.1, "output": 0.4}}, f)

            yaml_src = FilePriceSource(yaml_path)
            self.assertEqual(
                yaml_src.fetch_catalog(),
                {"model-y": {"input": 2.5, "output": 10.0}},
            )

            json_src = FilePriceSource(json_path)
            self.assertEqual(
                json_src.fetch_catalog(),
                {"model-z": {"input": 0.1, "output": 0.4}},
            )

            with self.assertRaises(FileNotFoundError):
                FilePriceSource(os.path.join(tmpdir, "nonexistent.yaml")).fetch_catalog()

    @mock.patch("urllib.request.urlopen")
    def test_http_json_price_source_success(self, mock_urlopen):
        payload = json.dumps({
            "claude-opus-5-5": {"input": 15.0, "output": 75.0},
            "unsupported-meta": "some string",
        }).encode("utf-8")

        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = payload
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        src = HttpJsonPriceSource("https://example.com/pricing.json")
        cat = src.fetch_catalog()

        self.assertIn("claude-opus-5-5", cat)
        self.assertEqual(cat["claude-opus-5-5"]["input"], 15.0)
        self.assertNotIn("unsupported-meta", cat)

    @mock.patch("urllib.request.urlopen")
    def test_http_json_price_source_network_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        src = HttpJsonPriceSource("https://example.com/pricing.json")
        with self.assertRaises(RuntimeError):
            src.fetch_catalog()

    def test_composite_price_source_merge(self):
        src1 = StaticPriceSource({
            "model-1": {"input": 1.0, "output": 2.0},
            "model-2": {"input": 0.5, "output": 1.0},
        })
        src2 = StaticPriceSource({
            "model-2": {"output": 1.2},  # 上書き
            "model-3": {"input": 3.0, "output": 9.0},
        })
        composite = CompositePriceSource([src1, src2])
        merged = composite.fetch_catalog()

        self.assertEqual(merged["model-1"], {"input": 1.0, "output": 2.0})
        self.assertEqual(merged["model-2"], {"input": 0.5, "output": 1.2})
        self.assertEqual(merged["model-3"], {"input": 3.0, "output": 9.0})


class TestCostWatcherCLI(unittest.TestCase):
    """CLI (main) の動作テスト"""

    def setUp(self):
        self.rates_path = os.path.join(os.path.dirname(__file__), "rates.yaml")

    def test_main_default_success(self):
        buf = StringIO()
        with mock.patch("sys.stdout", buf):
            code = main(["--rates-file", self.rates_path, "--check"])
        self.assertEqual(code, 0)
        self.assertIn("正常", buf.getvalue())

    def test_main_json_output(self):
        buf = StringIO()
        with mock.patch("sys.stdout", buf):
            code = main(["--rates-file", self.rates_path, "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(buf.getvalue())
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["mismatch_count"], 0)

    def test_main_mismatch_with_custom_catalog(self):
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write("claude-opus-5-5:\n  input: 99.00\n  output: 99.00\n")
            custom_cat = f.name

        try:
            buf = StringIO()
            with mock.patch("sys.stdout", buf):
                code = main([
                    "--rates-file", self.rates_path,
                    "--catalog-file", custom_cat,
                    "--check",
                ])
            self.assertEqual(code, 1)
            self.assertIn("単価乖離", buf.getvalue())
        finally:
            if os.path.exists(custom_cat):
                os.remove(custom_cat)

    def test_main_nonexistent_rates_file(self):
        err_buf = StringIO()
        with mock.patch("sys.stderr", err_buf):
            code = main(["--rates-file", "/nonexistent/rates.yaml"])
        self.assertEqual(code, 1)
        self.assertIn("読み込みに失敗", err_buf.getvalue())


if __name__ == "__main__":
    unittest.main()
