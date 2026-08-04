#include "local.h"
#include <stdio.h>
#define INVOKE(x) x

struct Item { int value; };
enum State { READY, DONE };
int declared(int value);
static int compute(int value) {
  const char *text = "fake_call()";
  return helper(value);
}
