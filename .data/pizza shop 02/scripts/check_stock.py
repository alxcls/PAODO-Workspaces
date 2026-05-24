"""
check_stock.py — Read-only inventory check. No file writes.

This script is safe to run concurrently — it never touches the edit queue.
Usage:
    python check_stock.py
    python check_stock.py <ingredient>
"""

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA_DIR = BASE / "data"
INGREDIENTS_FILE = DATA_DIR / "ingredients.json"
RECIPES_FILE = DATA_DIR / "recipes.json"


def load_inventory():
    with open(INGREDIENTS_FILE) as f:
        return json.load(f)


def print_inventory(data):
    print(f"\n=== Inventory (last updated: {data['last_updated']}) ===")
    for name, info in data["inventory"].items():
        bar = "#" * int(info["quantity"] // 10)
        print(f"  {name:<15} {info['quantity']:>5} {info['unit']:<8}  {bar}")


def print_feasibility(inventory):
    with open(RECIPES_FILE) as f:
        recipes = json.load(f)
    print("\n=== Pizzas we can make ===")
    for pizza, recipe in recipes.items():
        can_make = min(
            int(inventory[ing]["quantity"] // amt)
            for ing, amt in recipe.items()
            if ing in inventory
        )
        print(f"  {pizza:<15} up to {can_make} pizzas")


if __name__ == "__main__":
    data = load_inventory()

    if len(sys.argv) == 2:
        ingredient = sys.argv[1]
        if ingredient in data["inventory"]:
            info = data["inventory"][ingredient]
            print(f"{ingredient}: {info['quantity']} {info['unit']}")
        else:
            print(f"Unknown ingredient: {ingredient}")
        sys.exit(0)

    print_inventory(data)
    print_feasibility(data["inventory"])
