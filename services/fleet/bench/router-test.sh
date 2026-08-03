#!/usr/bin/env bash
# End-to-end through the node-local router: Host header in, app response out.
# Run with sudo.
set -u

DOMAIN=supersonic.cv
SLUG=$(python3 -c "
import json
r=[x for x in json.load(open('/srv/state/routes.json')) if x['healthy']]
print(r[0]['slug'] if r else '')" 2>/dev/null)

if [ -z "$SLUG" ]; then echo "no healthy app to test with"; exit 1; fi
echo "testing with app: $SLUG"
echo

echo "=== 1. correct Host -> the app answers"
curl -s -m 8 -o /tmp/r1 -w 'status=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer}s\n' \
  -H "Host: ${SLUG}.${DOMAIN}" http://127.0.0.1:8080/
head -c 120 /tmp/r1; echo; echo

echo "=== 2. unknown app -> 404, and says why"
curl -s -m 8 -o /tmp/r2 -w 'status=%{http_code}\n' \
  -H "Host: nosuchapp.${DOMAIN}" http://127.0.0.1:8080/
grep -o 'Not on this node[^<]*' /tmp/r2 | head -1
echo

echo "=== 3. wrong domain -> 404 rather than a wrong app"
curl -s -m 8 -o /tmp/r3 -w 'status=%{http_code}\n' \
  -H "Host: ${SLUG}.example.com" http://127.0.0.1:8080/
echo

echo "=== 4. Host carrying a port still resolves"
curl -s -m 8 -o /dev/null -w 'status=%{http_code}\n' \
  -H "Host: ${SLUG}.${DOMAIN}:8080" http://127.0.0.1:8080/
echo

echo "=== 5. a nested label is not an app"
curl -s -m 8 -o /dev/null -w 'status=%{http_code}\n' \
  -H "Host: a.${SLUG}.${DOMAIN}" http://127.0.0.1:8080/
echo

echo "=== 6. throughput through the router (100 sequential)"
start=$(date +%s%N)
for _ in $(seq 1 100); do
  curl -s -o /dev/null -H "Host: ${SLUG}.${DOMAIN}" http://127.0.0.1:8080/
done
end=$(date +%s%N)
echo "  100 requests in $(( (end-start)/1000000 )) ms  ($(( 100000000000 / (end-start) )) req/s)"
