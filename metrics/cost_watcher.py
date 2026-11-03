#!/usr/bin/env python3
"""
AI Agent モデル単価監視スクリプト (cost_watcher)。

rates.yaml に定義された各モデルの単価 (input, output, cache_read, cache_creation)
を最新の公称価格カタログ（参照定義ファイル、または外部API/URL）と突合し、
単価の乖離、未登録モデル、カタログ外モデルを検出・報告する。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

# collector.py から共通の rates パーサーと正規化関数をインポート
_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

try:
    from collector import default_rates_file, load_rates, normalize_identifier, parse_rates_yaml
except ImportError:
    from metrics.collector import default_rates_file, load_rates, normalize_identifier, parse_rates_yaml

# 業界標準で各社公称価格を常時トラッキングしているオープンソースのカタログエンドポイント
DEFAULT_LITELLM_CATALOG_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
)

SUPPORTED_RATE_FIELDS = ("input", "output", "cache_read", "cache_creation")


def default_reference_catalog_file() -> str:
    """リポジトリ同梱の公称価格参照カタログ (reference_catalog.yaml) のパスを解決"""
    return os.path.normpath(os.path.join(_DIR, "reference_catalog.yaml"))


@dataclass
class RateFieldDifference:
    """単価項目ごとの差分または未定義情報"""

    model: str
    field: str
    rates_value: float | None
    catalog_value: float | None
    diff: float | None
    status: str  # "mismatch" | "missing_in_rates" | "missing_in_catalog"

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "field": self.field,
            "rates_value": self.rates_value,
            "catalog_value": self.catalog_value,
            "diff": round(self.diff, 6) if self.diff is not None else None,
            "status": self.status,
        }


@dataclass
class CheckResult:
    """突合検証結果"""

    ok: bool
    differences: list[RateFieldDifference] = field(default_factory=list)
    missing_in_rates: list[str] = field(default_factory=list)
    missing_in_catalog: list[str] = field(default_factory=list)

    @property
    def mismatches(self) -> list[RateFieldDifference]:
        return [d for d in self.differences if d.status == "mismatch"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "difference_count": len(self.differences),
            "differences": [d.to_dict() for d in self.differences],
            "missing_in_rates": self.missing_in_rates,
            "missing_in_catalog": self.missing_in_catalog,
        }

    def format_report(self) -> str:
        lines: list[str] = []
        if self.ok:
            lines.append("【単価検証結果】: 正常 - すべての単価定義が公称カタログと整合しています。")
        else:
            lines.append("【単価検証結果】: 警告/異常 - 単価の乖離または不整合が検出されました。")

        mismatches = self.mismatches
        if mismatches:
            lines.append(f"\n■ 単価乖離 ({len(mismatches)} 件):")
            for m in mismatches:
                lines.append(
                    f"  - [{m.model}] {m.field}: rates.yaml={m.rates_value} vs カタログ={m.catalog_value} (差分: {m.diff:+.6f})"
                )

        field_missing = [d for d in self.differences if d.status != "mismatch"]
        if field_missing:
            lines.append(f"\n■ 項目過不足 ({len(field_missing)} 件):")
            for d in field_missing:
                r_str = f"{d.rates_value}" if d.rates_value is not None else "未定義"
                c_str = f"{d.catalog_value}" if d.catalog_value is not None else "未定義"
                lines.append(f"  - [{d.model}] {d.field}: rates.yaml={r_str} vs カタログ={c_str}")

        if self.missing_in_rates:
            lines.append(f"\n■ rates.yaml 未定義モデル (カタログに存在): {len(self.missing_in_rates)} 件")
            for model in self.missing_in_rates:
                lines.append(f"  - {model}")

        if self.missing_in_catalog:
            lines.append(f"\n■ カタログ外モデル (rates.yaml にのみ存在): {len(self.missing_in_catalog)} 件")
            for model in self.missing_in_catalog:
                lines.append(f"  - {model}")

        return "\n".join(lines)


def parse_catalog_dict(data: dict[str, Any]) -> dict[str, dict[str, float]]:
    """
    カタログ辞書をパースし、{model_name: {input: ..., output: ...}} 形式に正規化する。
    標準形式 ({model: {input: ...}}) および LiteLLM 形式 ({model: {input_cost_per_token: ...}}) の両方に対応。
    不正な値が含まれる場合はエラー（ValueError）とする（失敗を隠さない）。
    """
    if not isinstance(data, dict):
        raise ValueError(f"カタログデータは dict である必要があるが、{type(data).__name__} が渡された")

    # LiteLLM 形式かどうかの判定（要素内に input_cost_per_token があるか）
    is_litellm = any(
        isinstance(v, dict) and "input_cost_per_token" in v for v in data.values()
    )

    result: dict[str, dict[str, float]] = {}

    for model_key, model_val in data.items():
        if not isinstance(model_val, dict):
            # LiteLLM などのカタログメタデータキー (例: "sample_spec": "...") は無視
            if is_litellm:
                continue
            raise ValueError(f"モデル '{model_key}' の価格データが dict ではない: {model_val!r}")

        rates: dict[str, float] = {}

        if is_litellm:
            in_cost = model_val.get("input_cost_per_token")
            out_cost = model_val.get("output_cost_per_token")
            if in_cost is None and out_cost is None:
                continue

            try:
                if in_cost is not None:
                    rates["input"] = round(float(in_cost) * 1_000_000, 6)
                if out_cost is not None:
                    rates["output"] = round(float(out_cost) * 1_000_000, 6)
                cache_r = model_val.get("cache_read_input_token_cost")
                if cache_r is not None:
                    rates["cache_read"] = round(float(cache_r) * 1_000_000, 6)
                cache_c = model_val.get("cache_creation_input_token_cost")
                if cache_c is not None:
                    rates["cache_creation"] = round(float(cache_c) * 1_000_000, 6)
            except (ValueError, TypeError) as e:
                raise ValueError(f"モデル '{model_key}' のトークン単価変換に失敗: {e}") from e
        else:
            for fld, val in model_val.items():
                if fld not in SUPPORTED_RATE_FIELDS:
                    continue
                try:
                    rates[fld] = float(val)
                except (ValueError, TypeError) as e:
                    raise ValueError(f"モデル '{model_key}' のフィールド '{fld}' の値が数値ではない: {val!r}") from e

        if rates:
            result[model_key] = rates

    if not result:
        raise ValueError("カタログから有効なモデル単価を1件も取得できなかった")

    return result


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
            return parse_catalog_dict(data)

        # YAML のパース
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

        return parse_catalog_dict(data)


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


PREFERRED_PROVIDERS = (
    "anthropic/",
    "gemini/",
    "google/",
    "openai/",
    "azure_ai/",
    "vertex_ai/",
)


def resolve_catalog_model_key(
    model: str,
    catalog: dict[str, Any],
    direct_map: dict[str, str],
    suffix_map: dict[str, list[str]],
) -> str | None:
    """rates.yaml のモデル名に対応するカタログキーを解決する (完全一致・正規化・プロバイダー接頭辞対応)"""
    norm_m = normalize_identifier(model)
    if norm_m in direct_map:
        return direct_map[norm_m]

    candidates = suffix_map.get(norm_m, [])
    if not candidates:
        return None

    def sort_key(k: str) -> tuple[int, int, int, str]:
        for idx, pref in enumerate(PREFERRED_PROVIDERS):
            if k.startswith(pref):
                return (0, idx, len(k), k)
        return (1, 0, len(k), k)

    candidates.sort(key=sort_key)
    return candidates[0]


class CostWatcher:
    """
    モデル単価監視チェッカー。
    rates.yaml の各モデル単価と公称価格カタログを突合し、単価の乖離やモデルの消失を検出する。
    モデル名の表記ゆれやプロバイダー接頭辞は自動解決する。
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
        differences: list[RateFieldDifference] = []
        missing_in_catalog: list[str] = []

        direct_map = {normalize_identifier(k): k for k in self.catalog}
        suffix_map: dict[str, list[str]] = {}
        for k in self.catalog:
            suffix = k.rsplit("/", 1)[-1].split(":", 1)[0]
            norm_s = normalize_identifier(suffix)
            suffix_map.setdefault(norm_s, []).append(k)

        matched_catalog_keys: set[str] = set()

        for model in sorted(self.rates.keys()):
            cat_key = resolve_catalog_model_key(model, self.catalog, direct_map, suffix_map)
            if not cat_key:
                missing_in_catalog.append(model)
                continue

            matched_catalog_keys.add(cat_key)
            model_rates = self.rates[model]
            model_catalog = self.catalog[cat_key]

            fields_to_check = set(model_rates.keys()) | set(model_catalog.keys())
            for fld in sorted(fields_to_check):
                rate_val = model_rates.get(fld)
                cat_val = model_catalog.get(fld)

                if rate_val is None:
                    # rates.yaml に項目が未定義
                    differences.append(
                        RateFieldDifference(
                            model=model,
                            field=fld,
                            rates_value=None,
                            catalog_value=float(cat_val),
                            diff=None,
                            status="missing_in_rates",
                        )
                    )
                elif cat_val is None:
                    # カタログ側に項目が未定義
                    differences.append(
                        RateFieldDifference(
                            model=model,
                            field=fld,
                            rates_value=float(rate_val),
                            catalog_value=None,
                            diff=None,
                            status="missing_in_catalog",
                        )
                    )
                else:
                    diff = float(rate_val) - float(cat_val)
                    if abs(diff) > self.tolerance:
                        differences.append(
                            RateFieldDifference(
                                model=model,
                                field=fld,
                                rates_value=float(rate_val),
                                catalog_value=float(cat_val),
                                diff=diff,
                                status="mismatch",
                            )
                        )

        # カタログ側にのみ存在するモデル一覧（情報用）
        missing_in_rates = [
            k for k in sorted(self.catalog.keys()) if k not in matched_catalog_keys
        ]

        # OK 判定: 単価乖離がなく、かつ rates 側のモデルがカタログから消失していないこと
        # (カタログ側にのみ存在する他社モデル missing_in_rates は不整合とみなさない)
        mismatches = [d for d in differences if d.status == "mismatch"]
        is_ok = len(mismatches) == 0
        if any(d.status == "missing_in_rates" for d in differences):
            is_ok = False
        if not self.ignore_missing_in_catalog:
            if len(missing_in_catalog) > 0 or any(d.status == "missing_in_catalog" for d in differences):
                is_ok = False

        return CheckResult(
            ok=is_ok,
            differences=differences,
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
        help="突合する公称価格ファイルパス (YAML または JSON。未指定時は reference_catalog.yaml)",
    )
    parser.add_argument(
        "--catalog-url",
        default=None,
        help="突合する公称価格の外部 JSON URL",
    )
    parser.add_argument(
        "--online",
        action="store_true",
        help="外部の公称価格カタログ URL (LiteLLM 等) からフェッチして突合する",
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
    sources: list[PriceSource] = []

    if args.catalog_file:
        sources.append(FilePriceSource(args.catalog_file))
    elif not args.online and not args.catalog_url:
        ref_file = default_reference_catalog_file()
        if os.path.exists(ref_file):
            sources.append(FilePriceSource(ref_file))

    if args.online:
        url = args.catalog_url or DEFAULT_LITELLM_CATALOG_URL
        sources.append(HttpJsonPriceSource(url))
    elif args.catalog_url:
        sources.append(HttpJsonPriceSource(args.catalog_url))

    if not sources:
        print("エラー: 突合対象の価格カタログが指定されておらず、既定の参照カタログも見つかりません", file=sys.stderr)
        return 1

    catalog_source = CompositePriceSource(sources) if len(sources) > 1 else sources[0]
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
