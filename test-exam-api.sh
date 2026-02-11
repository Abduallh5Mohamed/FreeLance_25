#!/bin/bash
curl -s http://localhost:3001/api/exams/df6eb693-05c4-11f1-908f-94e8d4b653c4 | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('group_id:', d.get('group_id'))
print('group_ids:', d.get('group_ids'))
print('duration_minutes:', d.get('duration_minutes'))
"
