-- Separate database for the automated test suite so tests never touch dev data.
CREATE DATABASE kosh_test OWNER kosh;
