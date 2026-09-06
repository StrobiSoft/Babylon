#!/bin/bash
set -euo pipefail

echo "=== BBB1 PORT 55432 READ-ONLY CHECK ==="

if ss -ltn | awk 'NR>1 {print $4}' | grep -Eq '(^|:)55432$'; then
  echo "PORT_55432=IN_USE"
  ss -ltn | awk 'NR==1 || $4 ~ /:55432$/ {print}'
else
  echo "PORT_55432=FREE"
fi

echo "=== CHECK COMPLETE ==="
