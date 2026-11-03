#!/usr/bin/env python3
"""
AI Agent モデル単価監視スクリプト (cost_watcher)。

rates.yaml に定義された各モデルの単価 (input, output, cache_read, cache_creation)
を最新の公称価格カタログ（参照定義、ローカルファイル、または外部API/URL）と突合し、
単価の乖離、未登録モデル、カタログ外モデルを検出・報告する。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# collector.py から rates パーサーとローダーをインポート
_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

try:
    from collector import default_rates_file, load_rates, parse_rates_yaml
except ImportError:
    from metrics.collector import default_rates_file, load_rates, parse_rates_yaml


# 各社公称価格のベースライン参照カタログ（USD / 100万トークン）
# 外部通信が行えない環境（nix flake check、オフライン時）でも突合可能にする。
REFERENCE_OFFICIAL_CATALOG: dict[str, dict[str, float]] = {
    # Anthropic
    "claude-opus-5-5": {
        "input": 15.00,
        "output": 75.00,
        "cache_read": 1.50,
        "cache_creation": 18.75,
    },
    "claude-sonnet-5-5": {
        "input": 3.00,
        "output": 15.00,
        "cache_read": 0.30,
        "cache_creation": 3.75,
    },
    "claude-haiku-5-5": {
        "input": 0.80,
        "output": 4.00,
        "cache_read": 0.08,
        "cache_creation": 1.00,
    },
    # Google
    "gemini-3.8-flash": {
        "input": 0.10,
        "output": 0.40,
        "cache_read": 0.025,
    },
    "gemini-4-argon": {
        "input": 2.00,
        "output": 8.00,
        "cache_read": 0.50,
    },
    # OpenAI / Open-weights
    "gpt-oss-120b": {
        "input": 0.15,
        "output": 0.60,
        "cache_read": 0.03,
    },
}

SUPPORTED_RATE_FIELDS = ("input", "output", "cache_read", "cache_creation")


@dataclass
class RateFieldMismatch:
    """単価項目の不一致"""

    model: str
    field: str
    rates_value: float
    catalog_value: float
    diff: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "field": self.field,
            "rates_value": self.rates_value,
            "catalog_value": self.catalog_value,
            "diff": round(self.diff, 6),
        }


@dataclass
class CheckResult:
    """突合検証結果"""

    ok: bool
    mismatches: list[RateFieldMismatch] = field(default_factory=list)
    missing_in_rates: list[str] = field(default_factory=list)
    missing_in_catalog: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "mismatch_count": len(self.mismatches),
            "mismatches": [m.to_dict() for m in self.mismatches],
            "missing_in_rates": self.missing_in_rates,
            "missing_in_catalog": self.missing_in_catalog,
        }

    def format_report(self) -> str:
        lines: list[str] = []
        if self.ok:
            lines.append("【単価検証結果】: 正常 - すべての単価定義が公称カタログと一致しています。")
        else:
            lines.append("【単価検証結果】: 警告/異常 - 単価の乖離または不整合が検出されました。")

        if self.mismatches:
            lines.append(f"\n■ 単価乖離 ({len(self.mismatches)} 件):")
            for m in self.mismatches:
                lines.append(
                    f"  - [{m.model}] {m.field}: rates.yaml={m.rates_value} vs カタログ={m.catalog_value} (差分: {m.diff:+.6f})"
                )

        if self.missing_in_rates:
            lines.append(f"\n■ rates.yaml 未定義モデル (カタログに存在): {len(self.missing_in_rates)} 件")
            for model in self.missing_in_rates:
                lines.append(f"  - {model}")

        if self.missing_in_catalog:
            lines.append(f"\n■ カタログ外モデル (rates.yaml にのみ存在): {len(self.missing_in_catalog)} 件")
            for model in self.missing_in_catalog:
                lines.append(f"  - {model}")

        return "\n".join(lines)


class PriceSource:
    """価格データソースの抽象基底クラス"""

    def fetch_catalog(self) -> dict[str, dict[str, float]]:
        raise NotImplementedError


class StaticPriceSource(PriceSource):
    """静的辞書から価格カタログを提供するソース"""

    def __init__(self, catalog: dict[str, dict[str, float]]):
        self._catalog = catalog

    def fetch_catalog(self) -> dict[str, dict[str, float]]:
        return dict(self._catalog)


class FilePriceSource(PriceSource):
    """ローカルファイル (YAML または JSON) から価格カタログを読み込むソース"""

    def __init__(self, path: str):
        self.path = path

    def fetch_catalog(self) -> dict[str, dict[str, float]]:
        if not os.path.exists(self.path):
            raise FileNotFoundError(f"カタログファイルが存在しない: {self.path}")

        with open(self.path, "r", encoding="utf-8") as f:
            content = f.read()

        if self.path.endswith(".json"):
            data = json.loads(content)
            result: dict[str, dict[str, float]] = {}
            for model, rates in data.items():
                result[model] = {k: float(v) for k, v in rates.items()}
            return result

        # YAML のパース（collector の parse_rates_yaml を使用）
        return parse_rates_yaml(content)


class HttpJsonPriceSource(PriceSource):
    """外部 HTTP/HTTPS エンドポイントから JSON カタログをフェッチするソース"""

    def __init__(self, url: str, timeout_seconds: float = 10.0):
        self.url = url
        self.timeout = timeout_seconds

    def fetch_catalog(self) -> dict[str, dict[str, float]]:
        req = urllib.request.Request(
            self.url,
            headers={"User-Agent": "nuage-autopilot-cost-watcher/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            raise RuntimeError(f"外部価格カタログのフェッチに失敗 ({self.url}): {e}") from e

        # 構造を正規化して返す
        result: dict[str, dict[str, float]] = {}
        for model, rates in data.items():
            if isinstance(rates, dict):
                result[model] = {
                    k: float(v)
                    for k, v in rates.items()
                    if k in SUPPORTED_RATE_FIELDS and isinstance(v, (int, float))
                }
        return result


class CompositePriceSource(PriceSource):
    """複数の価格ソースを統合するソース（後から指定されたソースが優先）"""

    def __init__(self, sources: list[PriceSource]):
        self.sources = sources

    def fetch_catalog(self) -> dict[str, dict[str, float]]:
        merged: dict[str, dict[str, float]] = {}
        for src in self.sources:
            cat = src.fetch_catalog()
            for model, rates in cat.items():
                if model not in merged:
                    merged[model] = {}
                merged[model].update(rates)
        return merged


class CostWatcher:
    """
    モデル単価監視チェッカー。
    rates.yaml と公称価格カタログを突合し、単価の乖離やモデルの過不足を検出する。
    """

    def __init__(
        self,
        rates: dict[str, dict[str, float]],
        catalog: dict[str, dict[str, float]],
        tolerance: float = 1e-6,
        ignore_missing_in_catalog: bool = False,
    ):
        self.rates = rates
        self.catalog = catalog
        self.tolerance = tolerance
        self.ignore_missing_in_catalog = ignore_missing_in_catalog

    def check(self) -> CheckResult:
        mismatches: list[RateFieldMismatch] = []
        missing_in_rates: list[str] = []
        missing_in_catalog: list[str] = []

        all_models = set(self.rates.keys()) | set(self.catalog.keys())

        for model in sorted(all_models):
            in_rates = model in self.rates
            in_catalog = model in self.catalog

            if in_rates and not in_catalog:
                missing_in_catalog.append(model)
                continue

            if in_catalog and not in_rates:
                missing_in_rates.append(model)
                continue

            # 両方に存在する場合: 各フィールドの単価突合
            model_rates = self.rates[model]
            model_catalog = self.catalog[model]

            fields_to_check = set(model_rates.keys()) | set(model_catalog.keys())
            for fld in sorted(fields_to_check):
                # どちらか一方にしか存在しないフィールド
                rate_val = model_rates.get(fld)
                cat_val = model_catalog.get(fld)

                if rate_val is None:
                    # rates.yaml にフィールドが無い
                    diff = float(cat_val) - 0.0
                    if abs(diff) > self.tolerance:
                        mismatches.append(
                            RateFieldMismatch(
                                model=model,
                                field=fld,
                                rates_value=0.0,
                                catalog_value=float(cat_val),
                                diff=-diff,
                            )
                        )
                elif cat_val is None:
                    # catalog 側にフィールドが無い場合（例: cache_creation 未定義）
                    diff = float(rate_val) - 0.0
                    if abs(diff) > self.tolerance:
                        mismatches.append(
                            RateFieldMismatch(
                                model=model,
                                field=fld,
                                rates_value=float(rate_val),
                                catalog_value=0.0,
                                diff=diff,
                            )
                        )
                else:
                    diff = float(rate_val) - float(cat_val)
                    if abs(diff) > self.tolerance:
                        mismatches.append(
                            RateFieldMismatch(
                                model=model,
                                field=fld,
                                rates_value=float(rate_val),
                                catalog_value=float(cat_val),
                                diff=diff,
                            )
                        )

        # OK 判定: 単価乖離がなく、かつ rates 側の未登録がないこと
        # ignore_missing_in_catalog が真ならカタログ外モデルがあっても OK
        is_ok = len(mismatches) == 0 and len(missing_in_rates) == 0
        if not self.ignore_missing_in_catalog and len(missing_in_catalog) > 0:
            is_ok = False

        return CheckResult(
            ok=is_ok,
            mismatches=mismatches,
            missing_in_rates=missing_in_rates,
            missing_in_catalog=missing_in_catalog,
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="rates.yaml の単価定義と公称価格カタログを突合・監視する",
    )
    parser.add_argument(
        "--rates-file",
        default=None,
        help="突合対象の rates.yaml ファイルパス (未指定時は既定パスを自動解決)",
    )
    parser.add_argument(
        "--catalog-file",
        default=None,
        help="突合する公称価格ファイルパス (YAML または JSON)",
    )
    parser.add_argument(
        "--catalog-url",
        default=None,
        help="突合する公称価格の外部 JSON URL",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=1e-6,
        help="許容する単価誤差 (既定: 1e-6)",
    )
    parser.add_argument(
        "--ignore-missing-catalog",
        action="store_true",
        help="rates.yaml にのみ存在するモデル（独自/派生モデル）を不整合とみなさない",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="乖離や不整合が検出された場合に終了コード 1 で終了する",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="結果を JSON 形式で出力する",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    rates_path = args.rates_file or default_rates_file()
    try:
        rates = load_rates(rates_path)
    except Exception as e:
        print(f"エラー: rates.yaml の読み込みに失敗: {e}", file=sys.stderr)
        return 1

    # カタログソースの構築
    sources: list[PriceSource] = [StaticPriceSource(REFERENCE_OFFICIAL_CATALOG)]

    if args.catalog_file:
        sources.append(FilePriceSource(args.catalog_file))

    if args.catalog_url:
        sources.append(HttpJsonPriceSource(args.catalog_url))

    catalog_source = CompositePriceSource(sources)
    try:
        catalog = catalog_source.fetch_catalog()
    except Exception as e:
        print(f"エラー: カタログの取得に失敗: {e}", file=sys.stderr)
        return 1

    watcher = CostWatcher(
        rates=rates,
        catalog=catalog,
        tolerance=args.tolerance,
        ignore_missing_in_catalog=args.ignore_missing_catalog,
    )
    result = watcher.check()

    if args.json_output:
        print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
    else:
        print(result.format_report())

    if args.check and not result.ok:
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
