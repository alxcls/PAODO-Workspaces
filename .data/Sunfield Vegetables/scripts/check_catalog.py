"""
check_catalog.py — Read-only view of available stock and prices.

Usage:
    python scripts/check_catalog.py              # full catalog
    python scripts/check_catalog.py basil        # single ingredient
"""

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INVENTORY_FILE = BASE / "data" / "inventory.json"
CATALOG_FILE = BASE / "data" / "catalog.json"


def main():
    inventory = json.loads(INVENTORY_FILE.read_text())["inventory"]
    catalog = json.loads(CATALOG_FILE.read_text())["catalog"]

    if len(sys.argv) == 2:
        name = sys.argv[1]
        if name not in inventory:
            print(f"Unknown ingredient: {name}")
            sys.exit(1)
        item = inventory[name]
        print(f"{name}: {item['quantity']} {item['unit']} @ ${catalog[name]['price_per_unit']:.3f}/{item['unit']}")
        return

    print(f"{'Ingredient':<16} {'Stock':>8}  {'Unit':<8}  {'Price/unit':>10}")
    print("-" * 50)
    for name, item in inventory.items():
        print(f"{name:<16} {item['quantity']:>8}  {item['unit']:<8}  ${catalog[name]['price_per_unit']:>8.3f}")


if __name__ == "__main__":
    main()
