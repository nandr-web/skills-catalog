// One way to make the catalog's functions: Node 24 on arm64 (the hosted search needs node:sqlite with FTS5; the smoke
// test checks the version before anything else), bundled by the local esbuild only (never Docker, never an npm install
// in the asset) with the AWS SDK the tests ran against, given the table and bucket by name, logging to its own log group
// that goes with the stack.

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime, RuntimeManagementMode } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { Storage } from './storage.ts';

export const RUNTIME = Runtime.NODEJS_24_X;

/** The functions' entries, the folder they're bundled from, its lockfile, and the words file the API reads. */
export type CodeEntries = { api: string; indexer: string; sweep: string; projectRoot: string; lockFile: string; words: string };

// An ES module bundle has no require; a CommonJS dependency's require of a Node module gets one made for it.
const REQUIRE = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

export function catalogFunction(
  scope: Construct,
  p: {
    entry: string;
    projectRoot: string;
    lockFile: string;
    storage: Storage;
    removal: RemovalPolicy;
    runtimeVersionArn?: string | undefined;
    timeout?: Duration;
    environment?: Record<string, string>;
    /** A file put beside the bundle as words.yaml (the API's words): the only bundling hook. */
    words?: string;
  },
): NodejsFunction {
  const logGroup = new LogGroup(scope, 'Logs', { retention: RetentionDays.ONE_MONTH, removalPolicy: p.removal });
  const words = p.words;
  return new NodejsFunction(scope, 'Handler', {
    entry: p.entry,
    projectRoot: p.projectRoot,
    depsLockFilePath: p.lockFile,
    handler: 'handler',
    runtime: RUNTIME,
    architecture: Architecture.ARM_64,
    memorySize: 1024,
    timeout: p.timeout ?? Duration.seconds(29),
    logGroup,
    // Pinned to an exact runtime version where one is given (demo), so an automatic update can't swap it underneath.
    ...(p.runtimeVersionArn ? { runtimeManagementMode: RuntimeManagementMode.manual(p.runtimeVersionArn) } : {}),
    environment: { CATALOG_TABLE: p.storage.table.tableName, CATALOG_BUCKET: p.storage.bucket.bucketName, ...p.environment },
    bundling: {
      forceDockerBundling: false,
      format: OutputFormat.ESM,
      target: 'node24',
      sourceMap: false,
      minify: false,
      bundleAwsSDK: true,
      banner: REQUIRE,
      ...(words
        ? {
            commandHooks: {
              beforeBundling: () => [],
              beforeInstall: () => [],
              afterBundling: (_input: string, output: string) => [`cp ${JSON.stringify(words)} ${JSON.stringify(`${output}/words.yaml`)}`],
            },
          }
        : {}),
    },
  });
}
