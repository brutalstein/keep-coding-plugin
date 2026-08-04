#include "api.hpp"
#include <vector>

namespace demo {
template<class T>
T transform(T value) {
  return helper(value);
}

class Runner {
 public:
  void run() {
    transform(1);
  }
};
}
