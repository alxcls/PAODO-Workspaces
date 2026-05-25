"""
check_stock.py — Read-only inventory check. No file writes.

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


def load_recipes():
    with open(RECIPES_FILE) as f:
        return json.load(f)


def fmt_qty(qty):
    return int(qty) if qty == int(qty) else qty


def print_inventory(data):
    recipes = load_recipes()
    inventory = data["inventory"]

    print(f"\nInventory — {data['last_updated']}\n")
    print(f"  {'ingredient':<16} {'qty':>6}  unit")
    print(f"  {'─' * 16} {'─' * 6}  {'─' * 8}")

    for name, info in inventory.items():
        qty = info["quantity"]
        unit = info["unit"]
        pizzas = 0
        for recipe in recipes.values():
            if name in recipe:
                pizzas = max(pizzas, int(qty // recipe[name]))
        suffix = f"  → {pizzas} pizzas" if pizzas else ""
        print(f"  {name:<16} {fmt_qty(qty):>6}  {unit:<8}{suffix}")


def print_feasibility(inventory):
    recipes = load_recipes()
    print("\nPizzas we can make\n")

    for pizza, recipe in recipes.items():
        can_make = min(
            int(inventory[ing]["quantity"] // amt)
            for ing, amt in recipe.items()
            if ing in inventory
        )
        print(f"  {pizza:<16} {can_make} pizzas")


if __name__ == "__main__":
    data = load_inventory()

    if len(sys.argv) == 2:
        ingredient = sys.argv[1]
        if ingredient in data["inventory"]:
            info = data["inventory"][ingredient]
            print(f"{ingredient}: {fmt_qty(info['quantity'])} {info['unit']}")
        else:
            print(f"Unknown ingredient: {ingredient}")
        sys.exit(0)

    print_inventory(data)
    print_feasibility(data["inventory"])
