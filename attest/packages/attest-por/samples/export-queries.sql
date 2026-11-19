-- Example export queries for the balance file `attest-por build --csv` reads.
--
-- They are starting points, not something to run unchanged: the table and
-- column names (balances, user_id, currency, available, locked) are
-- placeholders for your own ledger's, and the three assets stand for your
-- own list. What matters is the shape of the result and the four properties
-- each query below keeps:
--
--   1. One row per account. Wallets of the same customer that are meant to
--      add up are summed here, in the query, where the rule can be reviewed
--      (GROUP BY).
--   2. Everything owed is counted. A balance locked in an open order or
--      waiting for a withdrawal is still the customer's (available + locked).
--   3. Amounts leave the database as text, never through a floating-point
--      type, so no digit is rounded on the way out (CAST ... AS CHAR / ::text).
--   4. The whole file comes from one point in time. Run the export inside a
--      single consistent-read transaction, or from a replica paused at the
--      snapshot time, and use that time as --asof.
--
-- The standard shape is one row per account and one column per asset, in a
-- UTF-8 CSV file with this header row:
--
--   account_id,BTC,ETH,USDT
--
-- (samples/balances.wide.csv). Every column other than the account is an
-- asset named in --assets, spelled exactly as it is there, capitals included
-- — which is why the asset aliases below are quoted where a database would
-- otherwise change their case. An account that holds none of an asset has 0
-- or an empty cell.
-- An account whose balances are all zero is one row like any other, and is
-- included in the snapshot at zero.
--
-- Negative balances are refused by the tool. A margin debt or an overdrawn
-- account has to be settled, netted or left out by a rule you decide and
-- record; the tool will not choose one for you.
--
-- With a long asset list, generate the SELECT list from the list itself —
-- or export one row per account and asset instead, which takes no list at
-- all: those queries are at the end of this file, and the tool reads that
-- shape as it is.


-- ── MySQL 8 / MariaDB ─────────────────────────────────────────────────────
-- A consistent read for the whole export:
--   SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
--   START TRANSACTION WITH CONSISTENT SNAPSHOT;
SELECT
  TRIM(CAST(user_id AS CHAR))                                                             AS account_id,
  CAST(SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END) AS CHAR)       AS `BTC`,
  CAST(SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END) AS CHAR)       AS `ETH`,
  CAST(SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END) AS CHAR)       AS `USDT`
FROM balances
GROUP BY user_id;
--   COMMIT;
-- From the shell, as a file (--batch prints tab-separated text):
--   mysql --batch --raw -e "<the query>" exchange > balances.tsv
--   attest-por build --csv balances.tsv --delimiter '\t' ...


-- ── PostgreSQL ────────────────────────────────────────────────────────────
-- BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- The aliases are quoted: unquoted, PostgreSQL would name the columns btc, eth, usdt.
SELECT
  btrim(user_id::text)                                                                    AS account_id,
  SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END)::text               AS "BTC",
  SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END)::text               AS "ETH",
  SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END)::text               AS "USDT"
FROM balances
GROUP BY user_id;
-- COMMIT;
-- From psql, straight to a CSV file with the header row:
--   \copy (<the query>) TO 'balances.csv' WITH (FORMAT csv, HEADER true)


-- ── Oracle ────────────────────────────────────────────────────────────────
-- SET TRANSACTION READ ONLY;
-- TO_CHAR with the TM9 format prints every digit and no exponent.
-- The asset aliases are quoted so a symbol with lower-case letters keeps them
-- (ACCOUNT_ID in capitals is read as account_id; an asset column is matched exactly).
SELECT
  TRIM(TO_CHAR(user_id))                                                                  AS account_id,
  TO_CHAR(SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END), 'TM9')     AS "BTC",
  TO_CHAR(SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END), 'TM9')     AS "ETH",
  TO_CHAR(SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END), 'TM9')     AS "USDT"
FROM balances
GROUP BY user_id;


-- ── SQL Server ────────────────────────────────────────────────────────────
-- SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION;
SELECT
  LTRIM(RTRIM(CAST(user_id AS varchar(64))))                                              AS account_id,
  CAST(SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END) AS varchar(80)) AS [BTC],
  CAST(SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END) AS varchar(80)) AS [ETH],
  CAST(SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END) AS varchar(80)) AS [USDT]
FROM balances
GROUP BY user_id;
-- COMMIT;


-- ── One row per account and asset instead (the long layout) ───────────────
-- The same ledger with no asset list in the query. The header row is
--
--   account_id,asset,balance
--
-- (samples/balances.long.csv), and the tool tells the two shapes apart by
-- it. A row that is zero is left out here; an account with nothing but
-- zeros is then not in the file, and so not in the snapshot — drop the
-- HAVING line to include it.

-- MySQL 8 / MariaDB
SELECT
  TRIM(CAST(user_id AS CHAR))                AS account_id,
  currency                                   AS asset,
  CAST(SUM(available + locked) AS CHAR)      AS balance
FROM balances
GROUP BY user_id, currency
HAVING SUM(available + locked) <> 0;

-- PostgreSQL
SELECT
  btrim(user_id::text)                       AS account_id,
  currency                                   AS asset,
  SUM(available + locked)::text              AS balance
FROM balances
GROUP BY user_id, currency
HAVING SUM(available + locked) <> 0;

-- Oracle
SELECT
  TRIM(TO_CHAR(user_id))                     AS account_id,
  currency                                   AS asset,
  TO_CHAR(SUM(available + locked), 'TM9')    AS balance
FROM balances
GROUP BY user_id, currency
HAVING SUM(available + locked) <> 0;

-- SQL Server
SELECT
  LTRIM(RTRIM(CAST(user_id AS varchar(64)))) AS account_id,
  currency                                   AS asset,
  CAST(SUM(available + locked) AS varchar(80)) AS balance
FROM balances
GROUP BY user_id, currency
HAVING SUM(available + locked) <> 0;
