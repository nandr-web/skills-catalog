#!/bin/sh
git log --merges --oneline "$(git describe --tags --abbrev=0)"..HEAD
