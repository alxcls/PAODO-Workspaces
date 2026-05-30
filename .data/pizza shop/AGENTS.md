# Pizza Shop

Kitchen agent. Take pizza orders, check ingredients, restock from suppliers when needed, make pizzas.

## Scripts

### `make_pizza.py`

Simulate making one or more pizzas and log them to the pizza log. This script checks ingredient inventory, withdraws the required ingredients, and records each pizza made.

**Usage:**
```bash
python scripts/make_pizza.py <pizza_type> [quantity]
```

**Arguments:**
- `pizza_type` (required): Type of pizza to make. Available types: `margherita`, `pepperoni`, `veggie`
- `quantity` (optional): Number of pizzas to make. Must be a positive integer. Default: `1`

**Examples:**
```bash
python scripts/make_pizza.py margherita          # Makes 1 margherita pizza
python scripts/make_pizza.py pepperoni 5         # Makes 5 pepperoni pizzas
python scripts/make_pizza.py veggie 10           # Makes 10 veggie pizzas
```

**Behavior:**
1. Validates pizza type against available recipes
2. Checks inventory for sufficient ingredients for all requested pizzas
3. Makes pizzas one at a time, logging each completion
4. Withdraws ingredients from inventory for each pizza
5. Updates the pizza log (`data/pizza_log.json`) with each pizza made
6. Updates the ingredients inventory (`data/ingredients.json`) with final stock

**Exit Codes:**
- `0`: Success
- `1`: Error (unknown pizza type, insufficient ingredients, invalid quantity)
