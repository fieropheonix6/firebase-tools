import * as clc from "colorette";
import { confirm, input, select } from "../../prompt";
import { logger } from "../../logger";
import * as utils from "../../utils";
import * as fsutils from "../../fsutils";
import { Config } from "../../config";
import {
  createInstance,
  DatabaseInstance,
  DatabaseInstanceType,
  DatabaseLocation,
  checkInstanceNameAvailable,
  getDatabaseInstanceDetails,
} from "../../management/database";
import * as ora from "ora";
import { ensure } from "../../ensureApiEnabled";
import { getDefaultDatabaseInstance } from "../../getDefaultDatabaseInstance";
import { FirebaseError } from "../../error";
import { Client } from "../../apiv2";
import { rtdbManagementOrigin } from "../../api";
import { Setup } from "..";

const DEFAULT_RULES = JSON.stringify(
  { rules: { ".read": "auth != null", ".write": "auth != null" } },
  null,
  2,
);

async function getDBRules(instanceDetails: DatabaseInstance): Promise<string> {
  if (!instanceDetails || !instanceDetails.name) {
    return DEFAULT_RULES;
  }
  const client = new Client({ urlPrefix: instanceDetails.databaseUrl });
  const response = await client.request<void, NodeJS.ReadableStream>({
    method: "GET",
    path: "/.settings/rules.json",
    responseType: "stream",
    resolveOnHTTPError: true,
  });
  if (response.status !== 200) {
    throw new FirebaseError(`Failed to fetch current rules. Code: ${response.status}`);
  }
  return await response.response.text();
}

function writeDBRules(
  rules: string,
  logMessagePrefix: string,
  filename: string,
  config: Config,
): void {
  config.writeProjectFile(filename, rules);
  utils.logSuccess(`${logMessagePrefix} have been written to ${clc.bold(filename)}.`);
  logger.info(
    `Future modifications to ${clc.bold(
      filename,
    )} will update Realtime Database Security Rules when you run`,
  );
  logger.info(clc.bold("firebase deploy") + ".");
}

async function createDefaultDatabaseInstance(project: string): Promise<DatabaseInstance> {
  const selectedLocation = await select({
    message: "Please choose the location for your default Realtime Database instance:",
    choices: [
      { name: "us-central1", value: DatabaseLocation.US_CENTRAL1 },
      { name: "europe-west1", value: DatabaseLocation.EUROPE_WEST1 },
      { name: "asia-southeast1", value: DatabaseLocation.ASIA_SOUTHEAST1 },
    ],
  });
  let instanceName = `${project}-default-rtdb`;
  // check if the conventional default instance name is available.
  const checkOutput = await checkInstanceNameAvailable(
    project,
    instanceName,
    DatabaseInstanceType.DEFAULT_DATABASE,
    selectedLocation,
  );
  // if the conventional instance name is not available, pick the first suggestion.
  if (!checkOutput.available) {
    if (!checkOutput.suggestedIds || checkOutput.suggestedIds.length === 0) {
      logger.debug(
        `No instance names were suggested instead of conventional instance name: ${instanceName}`,
      );
      throw new FirebaseError("Failed to create default RTDB instance");
    }
    instanceName = checkOutput.suggestedIds[0];
    logger.info(
      `${clc.yellow(
        "WARNING:",
      )} your project ID has the legacy name format, so your default Realtime Database instance will be named differently: ${instanceName}`,
    );
  }
  const spinner = ora(`Creating your default Realtime Database instance: ${instanceName}`).start();
  try {
    const createdInstance = await createInstance(
      project,
      instanceName,
      selectedLocation,
      DatabaseInstanceType.DEFAULT_DATABASE,
    );
    spinner.succeed();
    return createdInstance;
  } catch (err: any) {
    spinner.fail();
    throw err;
  }
}

async function initializeDatabaseInstance(projectId: string): Promise<DatabaseInstance | null> {
  await ensure(projectId, rtdbManagementOrigin(), "database", false);
  logger.info();

  const instance = await getDefaultDatabaseInstance({ project: projectId });
  if (instance !== "") {
    return await getDatabaseInstanceDetails(projectId, instance);
  }

  const createDefault = await confirm({
    message:
      "It seems like you haven’t initialized Realtime Database in your project yet. Do you want to set it up?",
    default: true,
  });

  if (createDefault) {
    return await createDefaultDatabaseInstance(projectId);
  }

  return null;
}

/**
 * doSetup is the entry point for setting up the database product.
 * @param setup information helpful for database setup
 * @param config legacy config parameter. not used for database setup.
 */
export async function doSetup(setup: Setup, config: Config): Promise<void> {
  setup.config = setup.config || {};

  let instanceDetails: DatabaseInstance | null = null;
  if (setup.projectId) {
    instanceDetails = await initializeDatabaseInstance(setup.projectId);
  }

  logger.info();
  logger.info(
    "Firebase Realtime Database Security Rules allow you to define how your data should be",
  );
  logger.info("structured and when your data can be read from and written to.");
  logger.info();

  const filename = await input({
    message: "What file should be used for Realtime Database Security Rules?",
    default: "database.rules.json",
  });
  if (!filename) {
    throw new FirebaseError("Must specify location for Realtime Database rules file.");
  }

  // Add 'database' section to config
  setup.config.database = { rules: filename };

  let writeRules = true;
  if (fsutils.fileExistsSync(filename)) {
    const rulesDescription = instanceDetails
      ? `the Realtime Database Security Rules for ${clc.bold(instanceDetails.name)} from the Firebase console`
      : "default rules";
    const msg = `File ${clc.bold(
      filename,
    )} already exists. Do you want to overwrite it with ${rulesDescription}?`;

    writeRules = await confirm(msg);
  }
  if (writeRules) {
    if (instanceDetails) {
      writeDBRules(
        await getDBRules(instanceDetails),
        `Database Rules for ${instanceDetails.name}`,
        filename,
        config,
      );
      return;
    }
    writeDBRules(DEFAULT_RULES, "Default rules", filename, config);
    return;
  }
  logger.info("Skipping overwrite of Realtime Database Security Rules.");
  logger.info(
    `The security rules defined in ${clc.bold(filename)} will be published when you run ${clc.bold(
      "firebase deploy",
    )}.`,
  );
  return;
}
