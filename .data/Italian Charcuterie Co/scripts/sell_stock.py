"""
sell_stock.py — Process a sale: deduct stock, log the transaction.

Usage:
    python scripts/sell_stock.py <ingredient> <quantity> [<buyer>]

Example:
    python scripts/sell_stock.py pepperoni 100 "supplier 02"
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INVENTORY_FILE = BASE / "data" / "inventory.json"
CATALOG_FILE = BASE / "data" / "catalog.json"
SALES_LOG_FILE = BASE / "data" / "sales_log.json"


def main():
    if len(sys.argv) < 3:
        print("Usage: python scripts/sell_stock.py <ingredient> <quantity> [<buyer>]")
        sys.exit(1)

    ingredient = sys.argv[1]
    try:
        quantity = float(sys.argv[2])
    except ValueError:
        print(f"Invalid quantity: {sys.argv[2]}")
        sys.exit(1)
    buyer = sys.argv[3] if len(sys.argv) >= 4 else "unknown"

    data = json.loads(INVENTORY_FILE.read_text())
    inventory = data["inventory"]
    catalog = json.loads(CATALOG_FILE.read_text())["catalog"]

    if ingredient not in inventory:
        print(f"Unknown ingredient: {ingredient}")
        sys.exit(1)

    item = inventory[ingredient]
    price_per_unit = catalog[ingredient]["price_per_unit"]

    if item["quantity"] < quantity:
        print(f"Insufficient stock: {ingredient} has {item['quantity']} {item['unit']}, requested {quantity}")
        sys.exit(1)

    total_price = round(quantity * price_per_unit, 2)
    item["quantity"] -= quantity
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    INVENTORY_FILE.write_text(json.dumps(data, indent=2))

    log = json.loads(SALES_LOG_FILE.read_text())
    sale = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "buyer": buyer,
        "ingredient": ingredient,
        "quantity": quantity,
        "unit": item["unit"],
        "price_per_unit": price_per_unit,
        "total": total_price,
    }
    log["sales"].append(sale)
    SALES_LOG_FILE.write_text(json.dumps(log, indent=2))

    print(f"OK: sold {quantity} {item['unit']} of {ingredient} to {buyer}")
    print(f"Total: ${total_price} | Remaining stock: {item['quantity']} {item['unit']}")


if __name__ == "__main__":
    main()
