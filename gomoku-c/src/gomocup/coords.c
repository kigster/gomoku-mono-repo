//
//  coords.c
//  gomoku-c — Gomocup brain
//
//  See coords.h for the why; this file is just the mechanical mapping.
//

#include "coords.h"

void gomocup_to_engine(int gx, int gy, int *row, int *col) {
  if (row)
    *row = gy;
  if (col)
    *col = gx;
}

void engine_to_gomocup(int row, int col, int *gx, int *gy) {
  if (gx)
    *gx = col;
  if (gy)
    *gy = row;
}

int gomocup_coord_in_bounds(int gx, int gy, int size) {
  return gx >= 0 && gy >= 0 && gx < size && gy < size;
}
