require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const dbConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbConfig);
  }
  return pool;
}

// API: Search inventory by item codes
app.get('/api/inventory', async (req, res) => {
  try {
    const { search, branch } = req.query;
    const db = await getPool();
    const request = db.request();

    let whereClause = 'WHERE 1=1';

    if (search && search.trim()) {
      request.input('search', sql.NVarChar, `%${search.trim()}%`);
      whereClause += ` AND (LTRIM(RTRIM(I.[IMLITM])) LIKE @search
                        OR LTRIM(RTRIM(I.[IMDSC1])) LIKE @search)`;
    }

    if (branch && branch.trim()) {
      request.input('branch', sql.NVarChar, branch.trim());
      whereClause += ` AND LTRIM(RTRIM(L.[LIMCU])) = @branch`;
    }

    const query = `
      SELECT TOP 500
        LTRIM(RTRIM(I.[IMLITM])) AS ItemCode,
        LTRIM(RTRIM(I.[IMDSC1])) AS Description,
        LTRIM(RTRIM(COLOR.DRDL01)) AS ColorThai,
        LTRIM(RTRIM(SIZE_T.DRDL01)) AS Size,
        LTRIM(RTRIM(L.[LIMCU])) AS Branch,
        I.[IMUOM1] AS UOM,
        L.[LIPQOH] / 100.0 AS QtyOnHand,
        (L.[LIHCOM] + L.[LIPCOM]) / 100.0 AS QtyReserved,
        (L.[LIPQOH] - L.[LIHCOM] - L.[LIPCOM]) / 100.0 AS AvailableToSell,
        DATEADD(SECOND,
          (CAST(L.[LITDAY] AS INT) / 10000 * 3600) +
          ((CAST(L.[LITDAY] AS INT) / 100 % 100) * 60) +
          (CAST(L.[LITDAY] AS INT) % 100),
          DATEADD(day, CAST(L.[LIUPMJ] AS INT) % 1000 - 1,
          DATEADD(year, CAST(L.[LIUPMJ] AS INT) / 1000, '1900-01-01'))
        ) AS LastUpdate
      FROM [DATABI].[dbo].[F41021] L WITH (NOLOCK)
      INNER JOIN [DATABI].[dbo].[F4101] I WITH (NOLOCK)
        ON L.[LIITM] = I.[IMITM]
      LEFT JOIN [DATABI].[dbo].[F0005] COLOR WITH (NOLOCK)
        ON LTRIM(RTRIM(COLOR.DRKY)) = LTRIM(RTRIM(I.IMSEG2))
        AND COLOR.DRSY = '55'
        AND COLOR.DRRT = 'CL'
      LEFT JOIN [DATABI].[dbo].[F0005] SIZE_T WITH (NOLOCK)
        ON LTRIM(RTRIM(SIZE_T.DRKY)) = LTRIM(RTRIM(I.IMSEG3))
        AND SIZE_T.DRSY = '55'
        AND SIZE_T.DRRT = 'SZ'
      ${whereClause}
        AND (L.[LIPQOH] - L.[LIHCOM] - L.[LIPCOM]) > 0
      ORDER BY I.[IMLITM], AvailableToSell DESC
    `;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Get branch list
app.get('/api/branches', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT LTRIM(RTRIM(L.[LIMCU])) AS Branch
      FROM [DATABI].[dbo].[F41021] L WITH (NOLOCK)
      WHERE L.[LIMCU] IS NOT NULL AND L.[LIMCU] <> ''
      ORDER BY Branch
    `);
    res.json(result.recordset.map(r => r.Branch));
  } catch (err) {
    console.error('Branch query error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
