"""
make_pizza.py — Simulate making one or more pizzas and logging them.

Usage:
    python make_pizza.py <pizza_type> [quantity]

Pizza types: margherita, pepperoni, veggie
Quantity: number of pizzas to make (default: 1)
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


def make_pizza(pizza_type, quantity=1):
    recipes = load_json(RECIPES_FILE)
    if pizza_type not in recipes:
        print(f"Unknown pizza type '{pizza_type}'. Available: {', '.join(recipes)}")
        sys.exit(1)

    recipe = recipes[pizza_type]

    # Load current inventory
    data = load_json(INGREDIENTS_FILE)
    inventory = data["inventory"]

    # Check if we have enough stock for all pizzas
    for i in range(quantity):
        ok, missing = check_stock(inventory, recipe)
        if not ok:
            print(f"Cannot make pizza #{i+1} — out of {missing}!")
            sys.exit(1)
        
        # Simulate baking time
        print(f"Making {pizza_type} pizza #{i+1}/{quantity}...")
        time.sleep(1)

        # Withdraw ingredients
        withdraw_ingredients(inventory, recipe)

        # Log the completed pizza
        log = load_json(PIZZA_LOG_FILE)
        entry = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "pizza": pizza_type,
            "ingredients_used": recipe,
        }
        log["pizzas_made"].append(entry)
        save_json(PIZZA_LOG_FILE, log)

    # Update inventory once after all pizzas are made
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    save_json(INGREDIENTS_FILE, data)

    print(f"{quantity} {pizza_type} pizza(s) done! Ingredients withdrawn.")


if __name__ == "__main__":
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        print("Usage: python make_pizza.py <pizza_type> [quantity]")
        sys.exit(1)
    
    pizza_type = sys.argv[1]
    quantity = 1
    
    if len(sys.argv) == 3:
        try:
            quantity = int(sys.argv[2])
            if quantity < 1:
                print("Quantity must be a positive integer!")
                sys.exit(1)
        except ValueError:
            print("Quantity must be a valid integer!")
            sys.exit(1)
    
    make_pizza(pizza_type, quantity)
