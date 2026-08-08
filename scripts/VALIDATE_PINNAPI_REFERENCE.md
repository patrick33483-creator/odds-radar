# PinnAPI reference validation

This validator compares PinnAPI with an authorized Pinnacle reference feed.
It does not scrape `pinnacle.com`.

## Important limitations

- The three requested IDs are:
  - `1633382529`: Servette Women vs Aktobe Women, not a Swedish league fixture.
  - `1633177726`: AIK Women vs Brommapojkarna Women.
  - `1633170584`: Vaxjo Women vs Rosengard Women.
- These fixtures have concluded. Live validation requires future matched events.
- Thirty-second polling cannot prove five-second latency. It only produces an
  interval-censored upper bound. Use a licensed push feed or polling at one
  second or faster to validate a five-second target.

## Reference response schema

The authorized reference endpoint must return JSON in this form:

```json
{
  "event_id": 1633177726,
  "source_timestamp": "2026-08-08T00:45:02Z",
  "status": "open",
  "spreads": [
    {"hdp": -0.75, "home": 1.93, "away": 1.89}
  ]
}
```

It may alternatively return the same `periods.num_0.spreads` structure as
PinnAPI. The URL must contain an `{event_id}` placeholder.

## Live run

Run this through a credential-enabled shell. Do not put either API key in the
command or in a file.

```bash
python scripts/validate_pinnapi_reference.py \
  --reference-url-template 'https://authorized.example/api/odds?event_id={event_id}' \
  --interval-seconds 30 \
  --duration-minutes 30
```

The JSONL output contains both response timings and normalized prices. The
terminal report includes paired success rate, exact-line price agreement,
closed/open mismatch, price changes while closed, and interval-censored quote
lag.

## Analyze existing PinnAPI-only logs

```bash
python scripts/validate_pinnapi_reference.py \
  --pinnapi-replay '1633382529=/home/user/workspace/pinnapi_servette_aktobe_t30_2026-08-07.jsonl' \
  --pinnapi-replay '1633177726=/home/user/workspace/pinnapi_swedish_women_t30_2026-08-08.jsonl' \
  --pinnapi-replay '1633170584=/home/user/workspace/pinnapi_swedish_women_t30_2026-08-08.jsonl'
```
