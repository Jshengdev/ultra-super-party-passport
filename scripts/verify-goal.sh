#!/usr/bin/env bash
# usp-v1 goal gate — exits nonzero while a leg is unmet. Contract: gx/goals/usp-v1.md
# Legs grow teeth as the build lands; a leg with no checker yet is an HONEST failure.
set -u
LEG="${1:-all}"
fail() { echo "verify:goal $1 → NOT MET ($2)"; exit 1; }
pass() { echo "verify:goal $1 → MET ($2)"; }
case "$LEG" in
  ingest)   [ -f data/test-party.csv ] || fail ingest "no test CSV yet"
            node --env-file=.env --import tsx scripts/check-conformance.ts || fail ingest "conformance checker failed or missing"
            pass ingest "conformance clean" ;;
  values)   node --env-file=.env --import tsx scripts/check-values.ts || fail values "values checker failed or missing"
            pass values "clusters present" ;;
  passport) ls data/passports/*.json >/dev/null 2>&1 || fail passport "no passports generated"
            node --env-file=.env --import tsx scripts/audit-receipts.ts || fail passport "receipts audit failed or missing"
            pass passport "all claims receipted" ;;
  universe) node --env-file=.env --import tsx scripts/check-universe.ts || fail universe "universe checker failed or missing"
            pass universe "renders all people" ;;
  checkin)  node --env-file=.env --import tsx scripts/check-checkin.ts || fail checkin "checkin checker failed or missing"
            pass checkin "state flip works" ;;
  ship)     node --env-file=.env --import tsx scripts/check-ship.ts || fail ship "ship checker failed or missing"
            pass ship "checklist complete" ;;
  all)      bash "$0" ingest && bash "$0" values && bash "$0" passport && bash "$0" universe && bash "$0" ship ;;
  *)        echo "unknown leg: $LEG"; exit 2 ;;
esac
