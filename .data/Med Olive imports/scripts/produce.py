"""
produce.py — Run an import batch for a single product.

Usage:
    python scripts/produce.py olives      # imports 5,000 grams
    python scripts/produce.py olive_oil   # imports 5,000 ml
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INVENTORY_FILE = BASE / "data" / "inventory.json"
PRODUCTION_LOG_FILE = BASE / "data" / "production_log.json"

BATCHES = {
    "olives": 5000.0,
    "olive_oil": 5000.0,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in BATCHES:
        print(f"Usage: python scripts/produce.py <{'|'.join(BATCHES)}>")
        sys.exit(1)

    ingredient = sys.argv[1]
    amount = BATCHES[ingredient]

    data = json.loads(INVENTORY_FILE.read_text())
    inventory = data["inventory"]
    inventory[ingredient]["quantity"] += amount
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    INVENTORY_FILE.write_text(json.dumps(data, indent=2))

    timestamp = datetime.now().isoformat(timespec="seconds")
    log = json.loads(PRODUCTION_LOG_FILE.read_text())
    log["batches"].append({
        "timestamp": timestamp,
        "produced": {ingredient: {"quantity": amount, "unit": inventory[ingredient]["unit"]}},
    })
    PRODUCTION_LOG_FILE.write_text(json.dumps(log, indent=2))

    unit = inventory[ingredient]["unit"]
    print(f"Imported {amount} {unit} of {ingredient} | new stock: {inventory[ingredient]['quantity']} {unit}")


if __name__ == "__main__":
    main()
