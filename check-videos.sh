#!/bin/bash
mysql freelance -e "SELECT status, processing_progress FROM videos ORDER BY created_at DESC LIMIT 10;"
