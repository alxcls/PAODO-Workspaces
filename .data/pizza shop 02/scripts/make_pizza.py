"""
make_pizza.py — Simulate making a pizza and logging it.

Usage:
    python make_pizza.py <pizza_type> <chef_name>

Pizza types: margherita, pepperoni, veggie
This script writes to pizza_log.json and ingredients.json — it will join the edit queue.
"""

import json
import sys
import time
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA_DIR = BASE / "data"
INGREDIENTS_FILE = DATA_DIR / "ingredients.json"
PIZZA_LOG_FILE = DATA_DIR / "pizza_log.json"
RECIPES_FILE = DATA_DIR / "recipes.json"
def load_json(path):
    with open(path) as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def check_stock(inventory, recipe):
    for ingredient, amount in recipe.items():
        if inventory.get(ingredient, {}).get("quantity", 0) < amount:
            return False, ingredient
    return True, None


def withdraw_ingredients(inventory, recipe):
    for ingredient, amount in recipe.items():
        inventory[ingredient]["quantity"] -= amount


def make_pizza(pizza_type, chef_name):
    recipes = load_json(RECIPES_FILE)
    if pizza_type not in recipes:
        print(f"Unknown pizza type '{pizza_type}'. Available: {', '.join(recipes)}")
        sys.exit(1)

    recipe = recipes[pizza_type]

    # Load current inventory
    data = load_json(INGREDIENTS_FILE)
    inventory = data["inventory"]

    # Check stock
    ok, missing = check_stock(inventory, recipe)
    if not ok:
        print(f"[{chef_name}] Cannot make {pizza_type} — out of {missing}!")
        sys.exit(1)

    # Simulate baking time
    print(f"[{chef_name}] Starting {pizza_type} pizza...")
    time.sleep(2)

    # Withdraw ingredients
    withdraw_ingredients(inventory, recipe)
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    save_json(INGREDIENTS_FILE, data)

    # Log the completed pizza
    log = load_json(PIZZA_LOG_FILE)
    entry = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "chef": chef_name,
        "pizza": pizza_type,
        "ingredients_used": recipe,
    }
    log["pizzas_made"].append(entry)
    save_json(PIZZA_LOG_FILE, log)

    print(f"[{chef_name}] {pizza_type.capitalize()} pizza done! Ingredients withdrawn.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python make_pizza.py <pizza_type> <chef_name>")
        sys.exit(1)
    make_pizza(sys.argv[1], sys.argv[2])
