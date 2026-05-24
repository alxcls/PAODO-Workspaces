"""
produce.py — Run a harvest batch: pick mushrooms and add to stock.

Usage:
    python scripts/produce.py

Each run harvests 10,000 grams of mushrooms.
"""

import json
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INVENTORY_FILE = BASE / "data" / "inventory.json"
PRODUCTION_LOG_FILE = BASE / "data" / "production_log.json"

BATCH = {"mushrooms": 10000.0}
ACTION = "harvested"


def main():
    data = json.loads(INVENTORY_FILE.read_text())
    inventory = data["inventory"]

    for ingredient, amount in BATCH.items():
        inventory[ingredient]["quantity"] += amount

    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    INVENTORY_FILE.write_text(json.dumps(data, indent=2))

    timestamp = datetime.now().isoformat(timespec="seconds")
    log = json.loads(PRODUCTION_LOG_FILE.read_text())
    batch_record = {
        "timestamp": timestamp,
        "produced": {k: {"quantity": v, "unit": inventory[k]["unit"]} for k, v in BATCH.items()},
    }
    log["batches"].append(batch_record)
    PRODUCTION_LOG_FILE.write_text(json.dumps(log, indent=2))

    print(f"{ACTION.capitalize()} complete:")
    for ingredient, amount in BATCH.items():
        print(f"  +{amount} {inventory[ingredient]['unit']} of {ingredient} | new stock: {inventory[ingredient]['quantity']} {inventory[ingredient]['unit']}")


if __name__ == "__main__":
    main()
