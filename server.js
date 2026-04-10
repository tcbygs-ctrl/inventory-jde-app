require('dotenv').config();
const express = require('express');
const oracledb = require('oracledb');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Oracle Thick mode (requires Instant Client)
oracledb.initOracleClient({ libDir: 'C:\\oracle\\instantclient_21_20' });
oracledb.autoCommit = true;
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const dbConfig = {
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT}/${process.env.ORACLE_SERVICE}`,
};

const SCHEMA = process.env.ORACLE_SCHEMA || 'PRODDTA';

let pool;

async function getPool() {
  if (!pool) {
    pool = await oracledb.createPool({
      ...dbConfig,
      poolMin: 2,
      poolMax: 10,
      poolTimeout: 60,
    });
    console.log('Oracle connection pool created');
  }
  return pool;
}

// API: Search inventory
app.get('/api/inventory', async (req, res) => {
  let conn;
  try {
    const { search, branch } = req.query;
    const p = await getPool();
    conn = await p.getConnection();

    let whereClauses = [];
    let binds = {};

    if (search && search.trim()) {
      whereClauses.push(
        `(TRIM(I.IMLITM) LIKE :search OR TRIM(I.IMDSC1) LIKE :search)`
      );
      binds.search = `%${search.trim()}%`;
    }

    if (branch && branch.trim()) {
      whereClauses.push(`TRIM(L.LIMCU) = :branch`);
      binds.branch = branch.trim();
    }

    // Always filter available > 0
    whereClauses.push(`(L.LIPQOH - L.LIHCOM - L.LIPCOM) > 0`);

    const whereSQL = whereClauses.length
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const query = `
      SELECT * FROM (
        SELECT
          TRIM(I.IMLITM) AS "ItemCode",
          TRIM(I.IMDSC1) AS "Description",
          TRIM(COLOR.DRDL01) AS "ColorThai",
          TRIM(SIZE_T.DRDL01) AS "Size",
          TRIM(L.LIMCU) AS "Branch",
          TRIM(I.IMUOM1) AS "UOM",
          L.LIPQOH / 100.0 AS "QtyOnHand",
          (L.LIHCOM + L.LIPCOM) / 100.0 AS "QtyReserved",
          (L.LIPQOH - L.LIHCOM - L.LIPCOM) / 100.0 AS "AvailableToSell",
          TO_DATE('1900-01-01','YYYY-MM-DD')
            + TRUNC(L.LIUPMJ / 1000) * INTERVAL '1' YEAR
            + (MOD(L.LIUPMJ, 1000) - 1) * INTERVAL '1' DAY
            + TRUNC(L.LITDAY / 10000) * INTERVAL '1' HOUR
            + TRUNC(MOD(L.LITDAY, 10000) / 100) * INTERVAL '1' MINUTE
            + MOD(L.LITDAY, 100) * INTERVAL '1' SECOND
          AS "LastUpdate"
        FROM ${SCHEMA}.F41021 L
        INNER JOIN ${SCHEMA}.F4101 I ON L.LIITM = I.IMITM
        LEFT JOIN PRODCTL.F0005 COLOR
          ON TRIM(COLOR.DRKY) = TRIM(I.IMSEG2)
          AND COLOR.DRSY = '55'
          AND COLOR.DRRT = 'CL'
        LEFT JOIN PRODCTL.F0005 SIZE_T
          ON TRIM(SIZE_T.DRKY) = TRIM(I.IMSEG3)
          AND SIZE_T.DRSY = '55'
          AND SIZE_T.DRRT = 'SZ'
        ${whereSQL}
        ORDER BY I.IMLITM, (L.LIPQOH - L.LIHCOM - L.LIPCOM) DESC
      ) WHERE ROWNUM <= 500
    `;

    const result = await conn.execute(query, binds);
    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

// API: Get branch list
app.get('/api/branches', async (req, res) => {
  let conn;
  try {
    const p = await getPool();
    conn = await p.getConnection();
    const result = await conn.execute(`
      SELECT DISTINCT TRIM(L.LIMCU) AS "Branch"
      FROM ${SCHEMA}.F41021 L
      WHERE L.LIMCU IS NOT NULL
      ORDER BY "Branch"
    `);
    res.json(result.rows.map(r => r.Branch));
  } catch (err) {
    console.error('Branch query error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (pool) await pool.close(0);
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
