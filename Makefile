.PHONY: test test-py test-js

test: test-py test-js

test-py:
	python3 -m pytest refresh/test_build_data.py -v

test-js:
	node --test test_app.js
