#!/usr/bin/env python3
"""
Validate PinnAPI against an authorized, normalized Pinnacle reference feed.

This script intentionally does not scrape pinnacle.com. Pinnacle's website
terms prohibit unauthorized automated access. The reference endpoint must be
an API or collector that the operator is authorized to use.

Expected normalized reference response:
{
  "event_id": 1633177726,
  "source_timestamp": "2026-08-08T00:45:02Z",
  "status": "open",
  "spreads": [
    {"hdp": -0.75, "home": 1.93, "away": 1.89}
  ]
}

The script also accepts a PinnAPI-shaped reference response with
periods.num_0.spreads.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_EVENTS = [1633382529, 1633177726, 1633170584]
PINNAPI_TEMPLATE = (
    "https://pinnapi.com/kit/v1/prematch/lines?event_id={event_id}"
)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.floor(len(ordered) * quantile))
    return ordered[index]


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_spreads(raw) -> dict[str, dict]:
    if isinstance(raw, dict):
        values = list(raw.values())
    elif isinstance(raw, list):
        values = raw
    else:
        values = []

    normalized = {}
    for entry in values:
        if not isinstance(entry, dict):
            continue
        hdp = to_float(entry.get("hdp", entry.get("line")))
        home = to_float(entry.get("home", entry.get("home_odds")))
        away = to_float(entry.get("away", entry.get("away_odds")))
        if hdp is None or home is None or away is None:
            continue
        normalized[f"{hdp:g}"] = {
            "hdp": hdp,
            "home": home,
            "away": away,
            "max": to_float(entry.get("max")),
        }
    return normalized


def normalize_payload(payload: dict, event_id: int) -> dict:
    period = ((payload.get("periods") or {}).get("num_0") or {})
    if period:
        status = period.get("status")
        spreads = normalize_spreads(period.get("spreads"))
        source_timestamp = payload.get("source_timestamp") or payload.get("last")
    else:
        status = payload.get("status")
        spreads = normalize_spreads(payload.get("spreads"))
        source_timestamp = payload.get("source_timestamp")
    return {
        "event_id": int(payload.get("event_id") or event_id),
        "source_timestamp": source_timestamp,
        "status": status,
        "spreads": spreads,
    }


async def curl_json(url: str, timeout: int) -> dict:
    started_ns = time.time_ns()
    process = await asyncio.create_subprocess_exec(
        "curl",
        "-sS",
        "--max-time",
        str(timeout),
        "-w",
        "\n%{http_code} %{time_total}",
        url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    received_ns = time.time_ns()
    text = stdout.decode("utf-8", errors="replace")
    body, _, trailer = text.rpartition("\n")
    trailer_parts = trailer.split()
    http_status = int(trailer_parts[0]) if trailer_parts else 0
    curl_seconds = (
        float(trailer_parts[1]) if len(trailer_parts) > 1 else None
    )
    error = stderr.decode("utf-8", errors="replace").strip() or None
    payload = None
    if body:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            error = f"JSONDecodeError: {exc}"
    return {
        "url": url,
        "started_ns": started_ns,
        "received_ns": received_ns,
        "latency_ms": (
            curl_seconds * 1000
            if curl_seconds is not None
            else (received_ns - started_ns) / 1_000_000
        ),
        "http_status": http_status,
        "payload": payload,
        "error": error,
    }


async def fetch_pair(
    event_id: int,
    reference_template: str,
    timeout: int,
) -> dict:
    pinnapi_url = PINNAPI_TEMPLATE.format(event_id=event_id)
    reference_url = reference_template.format(event_id=event_id)
    pinnapi_raw, reference_raw = await asyncio.gather(
        curl_json(pinnapi_url, timeout),
        curl_json(reference_url, timeout),
    )

    def finish(raw: dict) -> dict:
        normalized = None
        if raw["http_status"] == 200 and isinstance(raw["payload"], dict):
            normalized = normalize_payload(raw["payload"], event_id)
        return {
            "http_status": raw["http_status"],
            "latency_ms": raw["latency_ms"],
            "received_ns": raw["received_ns"],
            "error": raw["error"],
            "data": normalized,
        }

    return {
        "event_id": event_id,
        "sampled_at": iso_now(),
        "pinnapi": finish(pinnapi_raw),
        "reference": finish(reference_raw),
        "arrival_skew_ms": (
            pinnapi_raw["received_ns"] - reference_raw["received_ns"]
        )
        / 1_000_000,
    }


def quote_matches(a: dict, b: dict, tolerance: float) -> bool:
    return (
        abs(a["home"] - b["home"]) <= tolerance
        and abs(a["away"] - b["away"]) <= tolerance
    )


def analyze(rows: list[dict], interval_seconds: int, tolerance: float) -> dict:
    event_ids = sorted({int(row["event_id"]) for row in rows})
    report = {
        "generated_at": iso_now(),
        "sampling_interval_seconds": interval_seconds,
        "latency_resolution_warning": (
            "Quote-arrival latency is interval-censored. With 30-second polling, "
            "a measured match at the next sample means true latency lies within "
            "the preceding 30-second interval."
        ),
        "events": {},
    }

    all_success = []
    for event_id in event_ids:
        event_rows = [row for row in rows if int(row["event_id"]) == event_id]
        paired = [
            row
            for row in event_rows
            if row.get("pinnapi", {}).get("http_status") == 200
            and row.get("reference", {}).get("http_status") == 200
            and row.get("pinnapi", {}).get("data")
            and row.get("reference", {}).get("data")
        ]
        all_success.extend(paired)
        pinnapi_latencies = [
            row["pinnapi"]["latency_ms"]
            for row in event_rows
            if row.get("pinnapi", {}).get("http_status") == 200
        ]
        reference_latencies = [
            row["reference"]["latency_ms"]
            for row in event_rows
            if row.get("reference", {}).get("http_status") == 200
        ]

        compared_lines = 0
        matched_lines = 0
        closed_rows = 0
        closed_with_quote_change = 0
        closed_while_reference_open = 0
        previous_pinnapi_spreads = None
        observed_lag_upper_bounds = []

        for index, row in enumerate(paired):
            pinnapi = row["pinnapi"]["data"]
            reference = row["reference"]["data"]
            p_spreads = pinnapi["spreads"]
            r_spreads = reference["spreads"]

            for line in sorted(set(p_spreads) & set(r_spreads)):
                compared_lines += 1
                if quote_matches(p_spreads[line], r_spreads[line], tolerance):
                    matched_lines += 1

            if str(pinnapi.get("status")).lower() == "closed":
                closed_rows += 1
                if previous_pinnapi_spreads is not None and (
                    p_spreads != previous_pinnapi_spreads
                ):
                    closed_with_quote_change += 1
                if str(reference.get("status")).lower() in {
                    "open",
                    "active",
                    "available",
                }:
                    closed_while_reference_open += 1
            previous_pinnapi_spreads = p_spreads

            if index == 0:
                continue
            previous_reference = paired[index - 1]["reference"]["data"]["spreads"]
            for line, current_quote in r_spreads.items():
                if previous_reference.get(line) == current_quote:
                    continue
                for future_index in range(index, len(paired)):
                    future = paired[future_index]["pinnapi"]["data"]["spreads"]
                    if line in future and quote_matches(
                        future[line], current_quote, tolerance
                    ):
                        observed_lag_upper_bounds.append(
                            (future_index - index + 1) * interval_seconds
                        )
                        break

        success_rate = len(paired) / len(event_rows) if event_rows else 0
        line_agreement = (
            matched_lines / compared_lines if compared_lines else None
        )
        closed_mismatch_rate = (
            closed_while_reference_open / len(paired) if paired else None
        )
        event_report = {
            "samples": len(event_rows),
            "paired_successes": len(paired),
            "paired_success_rate": success_rate,
            "pinnapi_latency_ms": {
                "median": (
                    statistics.median(pinnapi_latencies)
                    if pinnapi_latencies
                    else None
                ),
                "p95": percentile(pinnapi_latencies, 0.95),
                "max": max(pinnapi_latencies) if pinnapi_latencies else None,
            },
            "reference_latency_ms": {
                "median": (
                    statistics.median(reference_latencies)
                    if reference_latencies
                    else None
                ),
                "p95": percentile(reference_latencies, 0.95),
                "max": max(reference_latencies) if reference_latencies else None,
            },
            "exact_line_price_agreement_rate": line_agreement,
            "compared_line_samples": compared_lines,
            "closed_samples": closed_rows,
            "closed_samples_with_price_change": closed_with_quote_change,
            "closed_while_reference_open_samples": closed_while_reference_open,
            "closed_while_reference_open_rate": closed_mismatch_rate,
            "quote_lag_upper_bound_seconds": {
                "samples": len(observed_lag_upper_bounds),
                "median": (
                    statistics.median(observed_lag_upper_bounds)
                    if observed_lag_upper_bounds
                    else None
                ),
                "p95": percentile(observed_lag_upper_bounds, 0.95),
                "max": (
                    max(observed_lag_upper_bounds)
                    if observed_lag_upper_bounds
                    else None
                ),
            },
        }
        event_report["validity_gate"] = {
            "success_rate_at_least_99pct": success_rate >= 0.99,
            "line_agreement_at_least_95pct": (
                line_agreement is not None and line_agreement >= 0.95
            ),
            "closed_mismatch_at_most_1pct": (
                closed_mismatch_rate is not None
                and closed_mismatch_rate <= 0.01
            ),
            "quote_lag_p95_at_most_5s": (
                bool(observed_lag_upper_bounds)
                and percentile(observed_lag_upper_bounds, 0.95) <= 5
            ),
        }
        event_report["validity_gate"]["passed"] = all(
            event_report["validity_gate"].values()
        )
        report["events"][str(event_id)] = event_report

    report["overall"] = {
        "samples": len(rows),
        "paired_successes": len(all_success),
        "note": (
            "A 5-second latency gate cannot be proven with a 30-second polling "
            "interval. Use a licensed push feed or poll at <=1 second for that gate."
        ),
    }
    return report


def analyze_pinnapi_replay(specs: list[str]) -> dict:
    output = {"generated_at": iso_now(), "events": {}}
    for spec in specs:
        event_text, path_text = spec.split("=", 1)
        event_id = int(event_text)
        rows = []
        with Path(path_text).open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                if "event_id" in row and int(row["event_id"]) != event_id:
                    continue
                if row.get("http_status") != 200 or not row.get("snapshot"):
                    continue
                rows.append(row)

        statuses = [
            str(row["snapshot"].get("status")).lower() for row in rows
        ]
        price_snapshots = []
        full_snapshots = []
        closed_price_changes = 0
        previous_prices = None
        for row in rows:
            spreads = normalize_spreads(row["snapshot"].get("spreads"))
            prices = {
                key: {
                    "hdp": value["hdp"],
                    "home": value["home"],
                    "away": value["away"],
                }
                for key, value in spreads.items()
            }
            limits = {key: value.get("max") for key, value in spreads.items()}
            price_snapshots.append(
                json.dumps(prices, sort_keys=True, separators=(",", ":"))
            )
            full_snapshots.append(
                json.dumps(
                    {"prices": prices, "limits": limits},
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
            if (
                previous_prices is not None
                and prices != previous_prices
                and str(row["snapshot"].get("status")).lower() == "closed"
            ):
                closed_price_changes += 1
            previous_prices = prices

        latencies = [row.get("latency_ms") for row in rows]
        latencies = [value for value in latencies if value is not None]
        if closed_price_changes:
            interpretation = (
                "Prices changed while status remained closed. Therefore closed "
                "does not, by itself, prove that the feed is stale. An authorized "
                "reference status is required to determine whether it means "
                "market suspension, non-bettable mirror state, or a mapping issue."
            )
        elif len(set(full_snapshots)) > len(set(price_snapshots)):
            interpretation = (
                "Prices stayed constant while limits changed and status remained "
                "closed. The feed was not fully static, but a reference source is "
                "still required to determine market synchronization."
            )
        else:
            interpretation = (
                "Prices, limits, and status stayed constant. This event alone "
                "cannot distinguish a stable market from a stale feed."
            )

        output["events"][str(event_id)] = {
            "samples": len(rows),
            "closed_samples": sum(status == "closed" for status in statuses),
            "unique_price_snapshots": len(set(price_snapshots)),
            "unique_price_and_limit_snapshots": len(set(full_snapshots)),
            "price_changes_while_closed": closed_price_changes,
            "latency_ms": {
                "median": statistics.median(latencies) if latencies else None,
                "p95": percentile(latencies, 0.95),
                "max": max(latencies) if latencies else None,
            },
            "interpretation": interpretation,
        }
    return output


async def poll(args) -> list[dict]:
    rows = []
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.duration_minutes * 60
    cycle = 0
    with output_path.open("a", encoding="utf-8") as handle:
        while time.monotonic() < deadline:
            cycle += 1
            started = time.monotonic()
            cycle_rows = await asyncio.gather(
                *[
                    fetch_pair(
                        event_id,
                        args.reference_url_template,
                        args.timeout_seconds,
                    )
                    for event_id in args.event_ids
                ]
            )
            for row in cycle_rows:
                row["cycle"] = cycle
                rows.append(row)
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            remaining = args.interval_seconds - (time.monotonic() - started)
            if remaining > 0:
                await asyncio.sleep(remaining)
    return rows


def load_rows(path: str) -> list[dict]:
    with Path(path).open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def validate_reference_url(template: str) -> None:
    try:
        parsed = urlparse(template.format(event_id=DEFAULT_EVENTS[0]))
    except Exception as exc:
        raise SystemExit(f"Invalid reference URL template: {exc}") from exc
    host = (parsed.hostname or "").lower()
    if host == "pinnacle.com" or host.endswith(".pinnacle.com"):
        raise SystemExit(
            "Direct pinnacle.com scraping is intentionally disabled. "
            "Use an authorized reference API or manually recorded snapshots."
        )
    if parsed.scheme != "https":
        raise SystemExit("The reference endpoint must use HTTPS.")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--event-ids",
        nargs="+",
        type=int,
        default=DEFAULT_EVENTS,
    )
    parser.add_argument("--interval-seconds", type=int, default=30)
    parser.add_argument("--duration-minutes", type=int, default=30)
    parser.add_argument("--timeout-seconds", type=int, default=15)
    parser.add_argument(
        "--reference-url-template",
        help="Authorized normalized API URL containing {event_id}.",
    )
    parser.add_argument(
        "--output",
        default="/home/user/workspace/pinnapi_reference_validation.jsonl",
    )
    parser.add_argument("--analyze-only")
    parser.add_argument(
        "--pinnapi-replay",
        action="append",
        default=[],
        metavar="EVENT_ID=JSONL",
    )
    parser.add_argument("--price-tolerance", type=float, default=0.005)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.pinnapi_replay:
        print(
            json.dumps(
                analyze_pinnapi_replay(args.pinnapi_replay),
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if args.analyze_only:
        rows = load_rows(args.analyze_only)
    else:
        if not args.reference_url_template:
            raise SystemExit(
                "--reference-url-template is required unless using "
                "--analyze-only or --pinnapi-replay."
            )
        validate_reference_url(args.reference_url_template)
        rows = asyncio.run(poll(args))
    report = analyze(rows, args.interval_seconds, args.price_tolerance)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
