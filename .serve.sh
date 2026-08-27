#!/bin/sh
if curl -s -o /dev/null http://127.0.0.1:4173/ 2>/dev/null; then
  echo "already up"; exit 0
fi
setsid npx vite preview --port 4173 >/tmp/preview.log 2>&1 < /dev/null &
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s -o /dev/null http://127.0.0.1:4173/ 2>/dev/null; then echo up; exit 0; fi
done
echo failed; exit 1
