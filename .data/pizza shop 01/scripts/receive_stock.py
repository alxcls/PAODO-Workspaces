"""
receive_stock.py — Apply a received delivery to the pizza shop inventory.

Usage:
    python receive_stock.py <ingredient> <quantity> [<supplier>]

Example:
    python receive_stock.py mushrooms 500 "supplier 01"
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA_DIR = BASE / "data"
INGREDIENTS_FILE = DATA_DIR / "ingredients.json"
STOCK_LOG_FILE = DATA_DIR / "stock_log.json"
def main():
    if len(sys.argv) < 3:
        print("Usage: python receive_stock.py <ingredient> <quantity> [<supplier>]")
        sys.exit(1)

    ingredient = sys.argv[1]
    try:
        quantity = float(sys.argv[2])
    except ValueError:
        print(f"Invalid quantity: {sys.argv[2]}")
        sys.exit(1)
    supplier = sys.argv[3] if len(sys.argv) >= 4 else "unknown"

    data = json.loads(INGREDIENTS_FILE.read_text())
    inventory = data["inventory"]

    if ingredient not in inventory:
        print(f"Unknown ingredient: {ingredient}")
        sys.exit(1)

    inventory[ingredient]["quantity"] += quantity
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    INGREDIENTS_FILE.write_text(json.dumps(data, indent=2))

    timestamp = datetime.now().isoformat(timespec="seconds")

    stock_data = json.loads(STOCK_LOG_FILE.read_text())
    stock_data["deliveries"].append({
        "timestamp": timestamp,
        "ingredient": ingredient,
        "quantity": quantity,
        "unit": inventory[ingredient]["unit"],
        "supplier": supplier,
    })
    STOCK_LOG_FILE.write_text(json.dumps(stock_data, indent=2))

    print(f"OK: added {quantity} {inventory[ingredient]['unit']} of {ingredient} to inventory")
    print(f"New stock: {inventory[ingredient]['quantity']} {inventory[ingredient]['unit']}")


if __name__ == "__main__":
    main()
