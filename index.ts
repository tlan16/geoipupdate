import {z} from 'zod';
import tmp from 'tmp';
import decompress from '@xhmikosr/decompress';
import decompressTargz from '@xhmikosr/decompress-targz';
import {copyFile, exists, lstat, mkdir, readdir, rm, rmdir, writeFile} from 'node:fs/promises'
import {join} from "node:path";
import {constants} from 'node:fs'
import {cpus} from "node:os";

// Minimal Zod schemas - only fields we actually use
const GitHubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
  content_type: z.string(),
});

const GitHubReleaseSchema = z.object({
  assets: z.array(GitHubAssetSchema),
});

// Type inference from Zod schemas
type GitHubAsset = z.infer<typeof GitHubAssetSchema>;
type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

function getPlatformSuffix(): string {
  // Get OS information
  const platform = process.platform;
  const arch = process.arch;

  // Map Node.js platform names to package naming convention
  let osName: string;
  switch (platform) {
    case 'darwin':
      osName = 'darwin';
      break;
    case 'linux':
      osName = 'linux';
      break;
    case 'win32':
      osName = 'windows';
      break;
    case 'freebsd':
      osName = 'freebsd';
      break;
    case 'openbsd':
      osName = 'openbsd';
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  // Map Node.js architecture names to package naming convention
  let archName: string;
  switch (arch) {
    case 'x64':
      archName = 'amd64';
      break;
    case 'ia32':
      archName = '386';
      break;
    case 'arm64':
      archName = 'arm64';
      break;
    case 'arm':
      // Note: This assumes ARMv6, but you might need more specific detection
      archName = 'armv6';
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  return `${osName}_${archName}`;
}

function getTarGzDownloadUrl(
  releaseJsonString: string,
  customPlatformSuffix?: string
): string {
  try {
    // Parse JSON string
    const rawData = JSON.parse(releaseJsonString);

    // Validate with Zod schema - only validates the fields we need
    const release = GitHubReleaseSchema.parse(rawData);

    const platformSuffix = customPlatformSuffix || getPlatformSuffix();

    // Find the .tar.gz asset that matches the specified platform
    const tarGzAsset = release.assets.find(asset =>
      asset.name.includes(platformSuffix) &&
      asset.name.endsWith('.tar.gz') &&
      asset.content_type === 'application/gzip'
    );

    if (!tarGzAsset) {
      const availablePlatforms = release.assets
        .filter(asset => asset.name.endsWith('.tar.gz'))
        .map(asset => asset.name)
        .join(', ');

      throw new Error(
        `No .tar.gz file found for platform: ${platformSuffix}. ` +
        `Available .tar.gz files: ${availablePlatforms}`
      );
    }

    return tarGzAsset.browser_download_url;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid JSON string provided');
    }
    if (error instanceof z.ZodError) {
      throw new Error(`Schema validation failed: ${error.message}`);
    }
    throw error;
  }
}

async function get_release_json() {
  const url = 'https://api.github.com/repos/maxmind/geoipupdate/releases/latest'
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch release info: ${response.statusText}`)
  }
  return await response.text()
}

function* use_temp_directory() {
  console.group()
  try {
    yield tmp.dirSync({prefix: 'geoipupdate-'}).name
  } finally {
    // cleanup
    console.groupEnd()
  }
}

async function get_geo_ip_update_executable() {
  const downloadUrl = getTarGzDownloadUrl(await get_release_json());
  const res = await fetch(downloadUrl)
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.statusText}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  for (const temp_directory of use_temp_directory()) {
    await decompress(buffer, temp_directory, {
      plugins: [
        decompressTargz()
      ]
    });
    console.log(`Extracted to: ${temp_directory}`)
    console.log(`Contents:`)
    const files = await readdir(temp_directory, {recursive: true})
    for (const file of files) {
      const file_path = join(temp_directory, file)
      const stats = await lstat(file_path)
      if (!stats.isFile()) {
        continue
      }
      if (!(await is_file_executable(file_path))) {
        continue
      }
      const executable_path = await get_geo_ip_update_executable_path()
      await copyFile(file_path, executable_path)
      console.log(`geoipupdate executable path: ${executable_path}`)
    }
  }
  return await get_geo_ip_update_executable_path()
}

async function is_file_executable(file_path: string) {
  // return !!(fs.statSync(p).mode & fs.constants.S_IXUSR)
  const stats = await lstat(file_path)
  const mode = stats.mode
  return Boolean(mode & constants.S_IXUSR)
}


async function get_data_directory() {
  const project_directory = import.meta.dirname
  const data_directory = join(project_directory, 'data')
  if (await exists(data_directory)) {
    if ((await lstat(data_directory)).isFile()) {
      await rm(data_directory)
    }
  } else {
    await mkdir(data_directory, {recursive: false})
  }
  return data_directory
}

async function get_geo_ip_update_executable_path() {
  const data_directory = await get_data_directory()
  const geo_ip_update_executable_path = join(data_directory, 'geoipupdate')
  if (!(await exists(geo_ip_update_executable_path))) {
    return geo_ip_update_executable_path
  }

  const stats = await lstat(geo_ip_update_executable_path)
  if (stats.isDirectory()) {
    await rmdir(geo_ip_update_executable_path)
  }
  return geo_ip_update_executable_path
}

async function create_config_file() {
  const account_id = process.env.MAXMIND_ACCOUNT_ID
  if (!account_id) {
    throw new Error('MAXMIND_ACCOUNT_ID environment variable is not set')
  }
  const license_key = process.env.MAXMIND_LICENSE_KEY
  if (!license_key) {
    throw new Error('MAXMIND_LICENSE_KEY environment variable is not set')
  }

  const lines = [
    `AccountID ${account_id}`,
    `LicenseKey ${license_key}`,
    `EditionIDs GeoLite2-ASN GeoLite2-City GeoLite2-Country`,
  ]
  const config_file_path = join(await get_data_directory(), 'maxmind.conf')
  await writeFile(config_file_path, lines.join('\n'), {encoding: 'utf-8', flag: 'w'})
  return config_file_path
}

async function update_geo_database() {
  const executable = await get_geo_ip_update_executable()
  const args = [
    `--config-file`, await create_config_file(),
    `--database-directory`, await get_data_directory(),
    `--parallelism`, cpus().length,
    '--verbose',
  ]
  console.log(`Executing: ${executable} ${args.join(' ')}`);
  const proc = Bun.spawn([executable, ...args]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`geoipupdate failed with exit code ${exitCode}`);
  }
  console.log('GeoIP database update completed successfully.');
}

// await update_geo_database()

import {Reader as MaxmindReader} from '@maxmind/geoip2-node'

export async function ip_to_city(ip: string) {
  if (!ip) {
    return undefined
  }
  const country_reader = await MaxmindReader.open(join(await get_data_directory(), 'GeoLite2-City.mmdb'))
  return country_reader.city(ip)
}
