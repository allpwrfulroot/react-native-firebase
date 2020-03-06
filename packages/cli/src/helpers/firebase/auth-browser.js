const http = require('http');
const { join } = require('path');
const { parse: urlParse } = require('url');
const { parse: qsParse } = require('querystring');

const A2A = require('a2a');
const Chalk = require('chalk');
const { decode } = require('jsonwebtoken');
const { getPortPromise } = require('portfinder');
const { OAuth2Client } = require('google-auth-library');

const File = require('../file');
const Open = require('../open');
const Spinner = require('../spinner');
const { promiseDefer } = require('../utils');

const OAUTH_CONFIG = {
  client_id: '467090028974-obb90livofalo0lmjq3n4agk7bocrrs8.apps.googleusercontent.com',
  client_secret: 'ktxgTUEr42PVVU4oD9Bk7ahn',
};

const DEFAULT_SCOPES = [
  'email',
  'openid',
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cloudplatformprojects.readonly',
];

/**
 * Read the contents of the specified html file in the responses directory
 *
 * @param name
 * @returns {Promise<void>}
 */
async function getResponseHtml(name) {
  const filePath = join(__dirname, `../../../templates/login-${name}.html`);
  return File.read(filePath);
}

module.exports = async function authWithBrowser(auth) {
  const requestDeferred = promiseDefer();

  // get an available/free port on the OS
  const port = await getPortPromise();

  // create a new google OAuth2Client with the free port
  const oAuth2Client = new OAuth2Client(
    OAUTH_CONFIG.client_id,
    OAUTH_CONFIG.client_secret,
    `http://localhost:${port}/oauth2callback`,
  );

  // generate the url that will be used for the consent dialog
  const authorizeUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    response_type: 'code',
    include_granted_scopes: true,
    scope: DEFAULT_SCOPES,
  });

  // open an http server to accept the oauth callback
  // only requests to /oauth2callback?code=<code> are accepted
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/oauth2callback') > -1) {
      requestDeferred.resolve([req, res]);
    }
  });

  server.listen(port);

  // open the url in the users browser to begin sign-in flow
  Open.openUrl(authorizeUrl);

  console.log('');
  console.log('Your browser should now open to the following URL: ');
  console.log('');
  console.log(Chalk.underline.blue(authorizeUrl));
  console.log('');

  const spinner = Spinner.create('Waiting for browser authentication to complete');

  spinner.start();

  // wait for the oauth callback to be called after consent granted
  const [req, res] = await requestDeferred.promise;

  // parse the request url and extract authorisation code
  const { code } = qsParse(urlParse(req.url).query);

  // respond to the browser and close http server
  const html = await getResponseHtml(code ? 'success' : 'failure');
  res.writeHead(code ? 200 : 500, {
    'Content-Type': 'text/html',
  });
  res.end(html);
  req.socket.destroy();
  server.close();

  if (!code) {
    spinner.fail('Error authenticating your account, please try again later.');
    return process.exit();
  }

  // exchange access token
  const [tokenError, { tokens }] = await A2A(oAuth2Client.getToken(code));
  if (tokenError) {
    spinner.fail('Error authenticating your account, please try again later.');
    return process.exit();
  }

  tokens.scopes = DEFAULT_SCOPES;
  oAuth2Client.setCredentials(tokens);

  // TODO should probably do a test request e.g. get projects list to confirm valid access
  const result = {
    user: decode(tokens.id_token),
    tokens,
  };

  auth.addAccount(result);

  spinner.succeed(`Successfully added account ${Chalk.cyanBright(`[${result.user.email}]`)}!`);

  console.log('');

  return Promise.resolve({
    client: oAuth2Client,
    ...result,
  });
};