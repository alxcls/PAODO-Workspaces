"""
receive_stock.py — Apply a delivery received from a producer to the supplier inventory.

Usage:
    python scripts/receive_stock.py <ingredient> <quantity> [<producer>]

Example:
    python scripts/receive_stock.py dough 20 "Artisan Bakery Co"
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INVENTORY_FILE = BASE / "data" / "inventory.json"


def main():
    if len(sys.argv) < 3:
        print("Usage: python scripts/receive_stock.py <ingredient> <quantity> [<producer>]")
        sys.exit(1)

    ingredient = sys.argv[1]
    try:
        quantity = float(sys.argv[2])
    except ValueError:
        print(f"Invalid quantity: {sys.argv[2]}")
        sys.exit(1)
    producer = sys.argv[3] if len(sys.argv) >= 4 else "unknown"

    data = json.loads(INVENTORY_FILE.read_text())
    inventory = data["inventory"]

    if ingredient not in inventory:
        print(f"Unknown ingredient: {ingredient}")
        sys.exit(1)

    inventory[ingredient]["quantity"] += quantity
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    INVENTORY_FILE.write_text(json.dumps(data, indent=2))

    print(f"OK: added {quantity} {inventory[ingredient]['unit']} of {ingredient} to inventory")
    print(f"New stock: {inventory[ingredient]['quantity']} {inventory[ingredient]['unit']}")


if __name__ == "__main__":
    main()
