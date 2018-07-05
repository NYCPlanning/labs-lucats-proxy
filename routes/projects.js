const express = require('express');
const path = require('path');
const SphericalMercator = require('sphericalmercator');
const NodeCache = require('node-cache');
const shortid = require('shortid');
const generateDynamicQuery = require('../utils/generate-dynamic-sql');
const turfBuffer = require('@turf/buffer');
const turfBbox = require('@turf/bbox');
const { Recaptcha } = require('express-recaptcha');
const github = require('octonode');


const recaptcha = new Recaptcha(process.env.RECAPTCHA_SITE_KEY, process.env.RECAPTCHA_SECRET_KEY);

const client = github.client(process.env.GITHUB_ACCESS_TOKEN);
const ghrepo = client.repo('NYCPlanning/zap-data-feedback');

const mercator = new SphericalMercator();
// tileCache key/value pairs expire after 1 hour
const tileCache = new NodeCache({ stdTTL: 3600 });
const router = express.Router();

// log the SQL query
const initOptions = {
  query(e) {
     (process.env.DEBUG === 'true') ? console.log(e.query) : null; // eslint-disable-line
  },
};

const pgp = require('pg-promise')(initOptions);
const getBblFeatureCollection = require('../utils/get-bbl-feature-collection');

// initialize database connection
const db = pgp(process.env.DATABASE_CONNECTION_STRING);
const host = process.env.HOST;

// helper for linking to external query files:
function sql(file) {
  const fullPath = path.join(__dirname, file);
  return new pgp.QueryFile(fullPath, { minify: true });
}

// import sql query templates
const listProjectsQuery = sql('../queries/projects/index.sql');
const findProjectQuery = sql('../queries/projects/show.sql');
const paginateQuery = sql('../queries/helpers/paginate.sql');
const standardColumns = sql('../queries/helpers/standard-projects-columns.sql');
const boundingBoxQuery = sql('../queries/helpers/bounding-box-query.sql');
const generateVectorTile = sql('../queries/helpers/generate-vector-tile.sql');

/* GET /projects */
router.get('/', async (req, res) => {
  // extract params, set defaults
  const {
    query: {
      // pagination
      page = '1',
      itemsPerPage = 30,

      // filters
      'community-districts': communityDistricts = [],
      'action-types': actionTypes = [],
      boroughs = [],
      dcp_ceqrtype = ['Type I', 'Type II', 'Unlisted', 'Unknown'],
      dcp_ulurp_nonulurp = ['ULURP', 'Non-ULURP'],
      dcp_femafloodzonev = false,
      dcp_femafloodzonecoastala = false,
      dcp_femafloodzonea = false,
      dcp_femafloodzoneshadedx = false,
      dcp_publicstatus = ['Complete', 'Filed', 'In Public Review', 'Unknown'],
      text_query = '',
      block = '',
    },
  } = req;

  const paginate = generateDynamicQuery(paginateQuery, { itemsPerPage, offset: (page - 1) * itemsPerPage });
  const communityDistrictsQuery =
    communityDistricts[0] ? pgp.as.format('AND dcp_validatedcommunitydistricts ilike any (array[$1:csv])', [communityDistricts.map(district => `%${district}%`)]) : '';

  const boroughsQuery = boroughs[0] ? pgp.as.format('AND dcp_borough ilike any (array[$1:csv])', [boroughs.map(borough => `%${borough}%`)]) : '';

  const actionTypesQuery = actionTypes[0] ? pgp.as.format('AND actiontypes ilike any (array[$1:csv])', [actionTypes.map(actionType => `%${actionType}%`)]) : '';

  // special handling for FEMA flood zones
  // to only filter when set to true
  const dcp_femafloodzonevQuery = dcp_femafloodzonev === 'true' ? 'AND dcp_femafloodzonev = true' : '';
  const dcp_femafloodzonecoastalaQuery = dcp_femafloodzonecoastala === 'true' ? 'AND dcp_femafloodzonecoastala = true' : '';
  const dcp_femafloodzoneaQuery = dcp_femafloodzonea === 'true' ? 'AND dcp_femafloodzonea = true' : '';
  const dcp_femafloodzoneshadedxQuery = dcp_femafloodzoneshadedx === 'true' ? 'AND dcp_femafloodzoneshadedx = true' : '';
  const textQuery = text_query ? pgp.as.format("AND ((dcp_projectbrief ilike '%$1:value%') OR (dcp_projectname ilike '%$1:value%') OR (dcp_applicant ilike '%$1:value%') OR (ulurpnumbers ilike '%$1:value%'))", [text_query]) : '';
  const blockQuery = block ? pgp.as.format("AND (blocks ilike '%$1:value%')", [block]) : '';

  try {
    const projects =
      await db.any(listProjectsQuery, {
        standardColumns,
        dcp_publicstatus,
        dcp_ceqrtype,
        dcp_ulurp_nonulurp,
        dcp_femafloodzonevQuery,
        dcp_femafloodzonecoastalaQuery,
        dcp_femafloodzoneaQuery,
        dcp_femafloodzoneshadedxQuery,
        communityDistrictsQuery,
        boroughsQuery,
        actionTypesQuery,
        textQuery,
        blockQuery,
        paginate,
      });

    const [{ total_projects: total = 0 } = {}] = projects || [];
    const { length = 0 } = projects;

    // if this is the first page of a new query, include bounds for the query's geoms, and a vector tile template
    let tileMeta = {};

    if (page === '1') {
      // tileQuery is uses the same WHERE clauses as above,
      // but only SELECTs geom, projectid, and projectname, and does not include pagination

      const tileQuery = pgp.as.format(listProjectsQuery, {
        standardColumns: 'geom, projectid, dcp_projectname, dcp_publicstatus_simp',
        dcp_publicstatus,
        dcp_ceqrtype,
        dcp_ulurp_nonulurp,
        dcp_femafloodzonevQuery,
        dcp_femafloodzonecoastalaQuery,
        dcp_femafloodzoneaQuery,
        dcp_femafloodzoneshadedxQuery,
        communityDistrictsQuery,
        boroughsQuery,
        actionTypesQuery,
        textQuery,
        blockQuery,
        paginate: '',
      });

      //create array of projects that have geometry 
      const projectsWithGeometries = projects.filter(project => project.has_centroid)

      // get the bounds for projects with geometry 
      // default to a bbox for the whole city
      //if project list has no geometries (projectsWithGeometries is 0) default to whole city
      let bounds = [[-74.2553345639348, 40.498580711525], [-73.7074928813077, 40.9141778017518]];
      if (projectsWithGeometries.length > 0) {
        bounds = await db.one(boundingBoxQuery, { tileQuery });
        bounds = bounds.bbox;
      }

      // if y coords are the same for both corners, the bbox is for a single point
      // to prevent fitBounds being lame, wrap a 600m buffer around the point

      if (bounds[0][0] === bounds[1][0]) {
        const point = {
          type: 'Point',
          coordinates: [
            bounds[0][0],
            bounds[0][1],
          ],
        };
        const buffer = turfBuffer(point, 0.4);
        const bbox = turfBbox.default(buffer);
        bounds = [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ];
      }

      // create a shortid for this query and store it in the cache
      const tileId = shortid.generate();
      await tileCache.set(tileId, tileQuery);

      tileMeta = {
        tiles: [`${host}/projects/tiles/${tileId}/{z}/{x}/{y}.mvt`],
        bounds,
      };
    }


    // send the response with a tile template
    res.send({
      data: projects.map(project => ({
        type: 'projects',
        id: project.dcp_name,
        attributes: project,
      })),
      meta: {
        total,
        pageTotal: length,
        ...tileMeta,
      },
    });
  } catch (e) {
    res.status(404).send({
      error: e.toString(),
    });
  }
});

/* GET /projects/:id */
/* Retreive a single project */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const project = await db.one(findProjectQuery, { id });
    project.bbl_featurecollection = await getBblFeatureCollection(project.bbls);

    res.send({
      data: {
        type: 'projects',
        id,
        attributes: project,
      },
    });
  } catch (e) {
    res.status(404).send({
      error: e.toString(),
    });
  }
});


/* GET /projects/tiles/:tileId/:z/:x/:y.mvt */
/* Retreive a vector tile by tileid */
router.get('/tiles/:tileId/:z/:x/:y.mvt', async (req, res) => {
  const {
    tileId,
    z,
    x,
    y,
  } = req.params;

  // retreive the projectids from the cache
  const tileQuery = await tileCache.get(tileId);
  // calculate the bounding box for this tile
  const bbox = mercator.bbox(x, y, z, false);

  try {
    const tile = await db.one(generateVectorTile, [...bbox, tileQuery]);

    res.setHeader('Content-Type', 'application/x-protobuf');

    if (tile.st_asmvt.length === 0) {
      res.status(204);
    }
    res.send(tile.st_asmvt);
  } catch (e) {
    res.status(404).send({
      error: e.toString(),
    });
  }
});

/* POST /projects/feedback */
/* Submit feedback about a project */
router.post('/feedback', recaptcha.middleware.verify, async (req, res) => {
  if (!req.recaptcha.error) {
    // create a new issue
    const { projectid, projectname, text } = req.body;
    ghrepo.issue({
      title: `Feedback about ${projectname}`,
      body: `Project ID: [${projectid}](https://zap.planning.nyc.gov/projects/${projectid})\nFeedback: ${text}`,
    }, () => {
      res.send({
        status: 'success',
      });
    });
  } else {
    res.status(403);
    res.send({
      status: 'captcha invalid',
    });
  }
});

module.exports = router;
