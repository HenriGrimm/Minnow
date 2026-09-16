#!/bin/bash
cat > /app/solution.py <<'PY'
def sum_even(values):
    return sum(value for value in values if value % 2 == 0)
PY
