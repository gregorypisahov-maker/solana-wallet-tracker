-- The HTTP extension was enabled temporarily to collect the 2026-07-23
-- Jupiter quote/build calibration sample. Runtime cost accounting does not
-- require database-side HTTP access.
drop extension if exists http;
