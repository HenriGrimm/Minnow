import sys
sys.path.insert(0, "/app")
from solution import sum_even
assert sum_even([1, 2, 3, 4]) == 6
assert sum_even([-4, -3, -2, -1, 0]) == -6
assert sum_even([]) == 0
assert sum_even([7, 9]) == 0
