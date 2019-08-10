const express = require('express');
const jwt = require('jsonwebtoken');

const UnauthError = require('../errors/unauth');
const BadRequestError = require('../errors/bad-request');
const { contactIdXML } = require('../queries/xml/contact-id');

const router = express.Router({ mergeParams: true });

const {
  CRM_SIGNING_SECRET,
  NYCID_CONSOLE_PASSWORD,
} = process.env;

router.get('/', async (req, res) => {
  const {
    app: { crmClient },
    query: { accessToken },
  } = req;

  try {
    // accessToken qp is required
    if (!accessToken) {
      throw new BadRequestError('accessToken required in querystring');
    }

    // Validate accessToken with NYCID_CONSOLE_PASSWORD. Will also throw error if token is expired
    const { email, expiresOn } = validateNYCIDToken(accessToken);

    // Validate exactly 1 contact exists in CRM associated with email from NYCID token
    const contactId = await getContactId(crmClient, email);

    // Create new token indicating NYCID and CRM authentication requirements met, with same exp as NYCID token
    const newToken = jwt.sign({ exp: expiresOn, contactId }, CRM_SIGNING_SECRET);
    res.cookie('token', newToken, { httpOnly: true }).send({ message: 'Login successful!' });
  } catch (e) {
    if (e instanceof BadRequestError) {
      res.status(e.status).send({ errors: [{ code: e.code, detail: e.message }] });
    }

    console.log(e);
    res.status(500).send({ errors: [{ detail: 'Unable to login' }] });
  }
});

function validateNYCIDToken(token) {
  try {
    const { mail, exp } = jwt.verify(token, NYCID_CONSOLE_PASSWORD);
    return { email: mail, expiresOn: exp };
  } catch (e) {
    console.log(e);
    throw new UnauthError(`Invalid NYCID token: ${e.message}`);
  }
}

async function getContactId(crmClient, email) {
  const response = await crmClient.doGet(`contacts?fetchXml=${contactIdXML(email)}`);
  const { value: contacts } = response;

  if (!contacts.length) {
    throw new UnauthError(`No CRM Contact found for email ${email}`);
  }

  if (contacts.length > 1) {
    throw new BadRequestError(`More than one CRM Contact found for email ${email}`);
  }

  return contacts.map(contact => contact.contactid)[0];
}

module.exports = router;