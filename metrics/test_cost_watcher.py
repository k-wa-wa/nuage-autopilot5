#!/usr/bin/env python3
"""
cost_watcher.py の単体テスト。
"""

import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from unittest import mock
import urllib.error

# テスト対象のインポート
sys.path.insert(0, os.path.dirname(__file__))

from cost_watcher import (
    CompositePriceSource,
    CostWatcher,
    FilePriceSource,
    HttpJsonPriceSource,
    StaticPriceSource,
    main,
    parse_catalog_dict,
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
        self.assertEqual(len(res.differences), 0)
        self.assertEqual(res.missing_in_rates, [])
        self.assertEqual(res.missing_in_catalog, [])

    def test_model_name_normalization_variants(self):
        # 表記ゆれ（ドット vs ハイフン）やプロバイダー接頭辞があっても突合できること
        rates = {
            "claude-opus-5-5": {"input": 15.0, "output": 75.0},
            "gemini-3.8-flash": {"input": 0.1, "output": 0.4},
            "gpt-oss-120b": {"input": 0.15, "output": 0.6},
        }
        catalog = {
            "claude-opus-5.5": {"input": 15.0, "output": 75.0},
            "gemini-3-8-flash": {"input": 0.1, "output": 0.4},
            "azure_ai/gpt-oss-120b": {"input": 0.15, "output": 0.6},
            "other-unknown-model": {"input": 1.0, "output": 2.0},  # カタログ側余剰モデル
        }
        watcher = CostWatcher(rates=rates, catalog=catalog)
        res = watcher.check()

        self.assertTrue(res.ok)
        self.assertEqual(res.missing_in_catalog, [])
        self.assertEqual(res.missing_in_rates, ["other-unknown-model"])
        self.assertEqual(len(res.differences), 0)

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
        mismatches = res.mismatches
        self.assertEqual(len(mismatches), 2)

        input_diff = next(m for m in mismatches if m.field == "input")
        self.assertEqual(input_diff.model, "model-a")
        self.assertEqual(input_diff.rates_value, 1.0)
        self.assertEqual(input_diff.catalog_value, 1.2)
        self.assertAlmostEqual(input_diff.diff, -0.2, places=5)
        self.assertEqual(input_diff.status, "mismatch")

        cache_diff = next(m for m in mismatches if m.field == "cache_read")
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

    def test_missing_field_in_rates_and_catalog(self):
        # rates 側に cache_creation があるが catalog には無い（カタログ未定義のため乖離がなければ ok=True）
        rates1 = {"model-a": {"input": 1.0, "output": 2.0, "cache_creation": 1.25}}
        catalog1 = {"model-a": {"input": 1.0, "output": 2.0}}
        watcher1 = CostWatcher(rates=rates1, catalog=catalog1)
        res1 = watcher1.check()
        self.assertTrue(res1.ok)
        self.assertEqual(len(res1.differences), 1)
        self.assertEqual(res1.differences[0].field, "cache_creation")
        self.assertEqual(res1.differences[0].status, "missing_in_catalog")
        self.assertEqual(res1.differences[0].rates_value, 1.25)
        self.assertIsNone(res1.differences[0].catalog_value)

        # catalog 側に cache_read があるが rates には無い（設定漏れのため ok=False）
        rates2 = {"model-a": {"input": 1.0, "output": 2.0}}
        catalog2 = {"model-a": {"input": 1.0, "output": 2.0, "cache_read": 0.25}}
        watcher2 = CostWatcher(rates=rates2, catalog=catalog2)
        res2 = watcher2.check()
        self.assertFalse(res2.ok)
        self.assertEqual(len(res2.differences), 1)
        self.assertEqual(res2.differences[0].field, "cache_read")
        self.assertEqual(res2.differences[0].status, "missing_in_rates")
        self.assertIsNone(res2.differences[0].rates_value)
        self.assertEqual(res2.differences[0].catalog_value, 0.25)

        # レポート表記に「未定義」が含まれること
        report = res2.format_report()
        self.assertIn("rates.yaml=未定義 vs カタログ=0.25", report)

    def test_model_mapping_and_ambiguous_candidates(self):
        rates = {"custom-model": {"input": 1.0, "output": 2.0}}
        catalog = {
            "prov_a/custom-model": {"input": 1.0, "output": 2.0},
            "prov_b/custom-model": {"input": 3.0, "output": 6.0},
        }

        # 1. マッピング未指定で複数候補の単価が食い違う場合 -> 曖昧エラーで ok=False
        watcher_ambig = CostWatcher(rates=rates, catalog=catalog)
        res_ambig = watcher_ambig.check()
        self.assertFalse(res_ambig.ok)
        self.assertEqual(len(res_ambig.resolution_errors), 1)
        self.assertIn("候補が複数存在", res_ambig.resolution_errors[0])

        # 2. model_mapping で明示的に prov_a を指定した場合 -> 一致して ok=True
        watcher_mapped = CostWatcher(
            rates=rates,
            catalog=catalog,
            model_mapping={"custom-model": "prov_a/custom-model"},
        )
        res_mapped = watcher_mapped.check()
        self.assertTrue(res_mapped.ok)
        self.assertEqual(len(res_mapped.differences), 0)

        # 3. model_mapping で prov_b を指定した場合 -> 単価乖離を検知して ok=False
        watcher_mapped_b = CostWatcher(
            rates=rates,
            catalog=catalog,
            model_mapping={"custom-model": "prov_b/custom-model"},
        )
        res_mapped_b = watcher_mapped_b.check()
        self.assertFalse(res_mapped_b.ok)
        self.assertEqual(len(res_mapped_b.mismatches), 2)

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

        # ignore_missing_in_catalog=True の場合
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


class TestPriceSources(unittest.TestCase):
    """各 PriceSource とカタログパースの動作テスト"""

    def test_parse_catalog_dict_standard(self):
        data = {
            "model-x": {"input": 1.5, "output": 3.0},
            "model-y": {"input": "2.0", "output": 4.0},  # 文字列数値も許容
        }
        res = parse_catalog_dict(data)
        self.assertEqual(res["model-x"], {"input": 1.5, "output": 3.0})
        self.assertEqual(res["model-y"], {"input": 2.0, "output": 4.0})

    def test_parse_catalog_dict_litellm_format(self):
        # LiteLLM の 1トークンあたり単価から 100万トークン単価への換算
        data = {
            "claude-opus-5-5": {
                "input_cost_per_token": 0.000015,
                "output_cost_per_token": 0.000075,
                "cache_read_input_token_cost": 0.0000015,
                "cache_creation_input_token_cost": 0.00001875,
            },
            "sample_spec": "metadata string",  # メタデータはスキップ
        }
        res = parse_catalog_dict(data)
        self.assertIn("claude-opus-5-5", res)
        self.assertEqual(res["claude-opus-5-5"]["input"], 15.0)
        self.assertEqual(res["claude-opus-5-5"]["output"], 75.0)
        self.assertEqual(res["claude-opus-5-5"]["cache_read"], 1.5)
        self.assertEqual(res["claude-opus-5-5"]["cache_creation"], 18.75)

    def test_parse_catalog_dict_invalid_data_fails(self):
        # 失敗を隠さない: 不正な型や壊れたデータは例外を投げる
        with self.assertRaises(ValueError):
            parse_catalog_dict("not a dict")  # type: ignore

        with self.assertRaises(ValueError):
            parse_catalog_dict({"model-z": "not a dict value"})

        with self.assertRaises(ValueError):
            parse_catalog_dict({"model-z": {"input": "NOT_A_FLOAT"}})

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
            "claude-opus-5-5": {
                "input_cost_per_token": 0.000015,
                "output_cost_per_token": 0.000075,
            }
        }).encode("utf-8")

        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = payload
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        src = HttpJsonPriceSource("https://example.com/pricing.json")
        cat = src.fetch_catalog()

        self.assertIn("claude-opus-5-5", cat)
        self.assertEqual(cat["claude-opus-5-5"]["input"], 15.0)

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
        self.ref_path = os.path.join(os.path.dirname(__file__), "reference_catalog.yaml")

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
        self.assertEqual(parsed["difference_count"], 0)

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

    @mock.patch("urllib.request.urlopen")
    def test_main_online_flag(self, mock_urlopen):
        # --online で外部フェッチを行うテスト
        payload = json.dumps({
            "claude-opus-5-5": {
                "input_cost_per_token": 0.000015,
                "output_cost_per_token": 0.000075,
                "cache_read_input_token_cost": 0.0000015,
                "cache_creation_input_token_cost": 0.00001875,
            }
        }).encode("utf-8")
        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = payload
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        buf = StringIO()
        with mock.patch("sys.stdout", buf):
            code = main([
                "--rates-file", self.rates_path,
                "--online",
                "--ignore-missing-catalog",
                "--check",
            ])
        self.assertEqual(code, 0)

    def test_main_nonexistent_rates_file(self):
        err_buf = StringIO()
        with mock.patch("sys.stderr", err_buf):
            code = main(["--rates-file", "/nonexistent/rates.yaml"])
        self.assertEqual(code, 1)
        self.assertIn("読み込みに失敗", err_buf.getvalue())


if __name__ == "__main__":
    unittest.main()
