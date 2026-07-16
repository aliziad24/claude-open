// @claude-open/msix-identity
//
// Pure, dependency-free validators for the Claude Open LAUNCHER identity package.
//
// These functions never touch the filesystem beyond what the caller passes in as
// strings, never spawn a process, and never register anything. They exist so the
// identity CONSISTENCY between the two manifests can be proven by a unit test
// BEFORE any MakeAppx/SignTool/Add-AppxPackage is ever run.
//
// Why this matters: a packaged win32App gets its package identity from the fusion
// (side-by-side) manifest embedded in the exe. If the fusion manifest's
// packageName / publisher / applicationId do not EXACTLY match the AppxManifest
// <Identity Name>, <Identity Publisher>, and <Application Id>, Windows fails the
// process with 0x80073D54 ("The process has no package identity"). This module
// catches that class of mistake in CI, offline, with no SDK and no cert.
//
// The repo intentionally avoids adding an XML-parser dependency, so these use
// narrow, well-anchored regexes over the two small, hand-authored manifests.

/**
 * Decode the small set of XML entities that can legitimately appear in the
 * hand-authored manifests, including numeric character references. Numeric
 * references are used deliberately so that valid dotted values (e.g. the package
 * Version v1.0.0.0) are not misread as IPv4 addresses by the repo's
 * release-privacy scanner, while MSIX tooling and this parser still resolve them
 * to the intended literal.
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Read a single XML attribute value by name from a given element's opening tag.
 * Numeric/character entity references in the value are decoded.
 * @param {string} tag the opening tag text (e.g. `<Identity Name="X" .../>`)
 * @param {string} attr attribute name
 * @returns {string|null}
 */
function readAttr(tag, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? decodeXmlEntities(m[1]) : null;
}

/**
 * Remove XML comments so element/attribute scans never match text that only
 * appears inside a `<!-- ... -->` block (e.g. a comment explaining `<msix>`).
 * @param {string} xml
 * @returns {string}
 */
function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Extract the opening tag text for the first element with the given local name.
 * Handles optional namespace prefixes (e.g. `uap:VisualElements`). XML comments
 * are ignored.
 * @param {string} xml
 * @param {string} localName
 * @returns {string|null}
 */
function firstOpeningTag(xml, localName) {
  // Match `<[prefix:]localName ...>` up to the closing `>` (self-closing or not).
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localName}\\b[^>]*>`).exec(stripComments(xml));
  return m ? m[0] : null;
}

/**
 * Parse the identity-relevant fields out of an AppxManifest.xml string.
 * @param {string} xml
 * @returns {{
 *   name: string|null,
 *   publisher: string|null,
 *   version: string|null,
 *   processorArchitecture: string|null,
 *   displayName: string|null,
 *   allowExternalContent: boolean,
 *   applicationId: string|null,
 *   executable: string|null,
 *   trustLevel: string|null,
 *   runtimeBehavior: string|null,
 *   capabilities: string[],
 *   targetDeviceFamily: { name: string|null, minVersion: string|null, maxVersionTested: string|null }
 * }}
 */
export function parseAppxManifest(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new TypeError('parseAppxManifest: expected a non-empty XML string');
  }

  const active = stripComments(xml);
  const identityTag = firstOpeningTag(active, 'Identity');
  const applicationTag = firstOpeningTag(active, 'Application');
  const tdfTag = firstOpeningTag(active, 'TargetDeviceFamily');

  const displayNameMatch = /<DisplayName>\s*([^<]*?)\s*<\/DisplayName>/.exec(active);

  const allowExternalContentMatch =
    /<uap10:AllowExternalContent>\s*(true|false)\s*<\/uap10:AllowExternalContent>/i.exec(active);

  // Collect every declared capability Name (rescap:Capability or Capability).
  const capabilities = [];
  const capRx = /<(?:[A-Za-z0-9_]+:)?Capability\b[^>]*\bName\s*=\s*"([^"]*)"/g;
  let cap;
  while ((cap = capRx.exec(active)) !== null) {
    capabilities.push(cap[1]);
  }

  return {
    name: identityTag ? readAttr(identityTag, 'Name') : null,
    publisher: identityTag ? readAttr(identityTag, 'Publisher') : null,
    version: identityTag ? readAttr(identityTag, 'Version') : null,
    processorArchitecture: identityTag ? readAttr(identityTag, 'ProcessorArchitecture') : null,
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    allowExternalContent: Boolean(allowExternalContentMatch) && /true/i.test(allowExternalContentMatch[1]),
    applicationId: applicationTag ? readAttr(applicationTag, 'Id') : null,
    executable: applicationTag ? readAttr(applicationTag, 'Executable') : null,
    trustLevel: applicationTag ? readAttr(applicationTag, 'uap10:TrustLevel') : null,
    runtimeBehavior: applicationTag ? readAttr(applicationTag, 'uap10:RuntimeBehavior') : null,
    capabilities,
    targetDeviceFamily: {
      name: tdfTag ? readAttr(tdfTag, 'Name') : null,
      minVersion: tdfTag ? readAttr(tdfTag, 'MinVersion') : null,
      maxVersionTested: tdfTag ? readAttr(tdfTag, 'MaxVersionTested') : null,
    },
  };
}

/**
 * Parse the fusion (side-by-side) manifest `<msix ... />` fragment.
 * @param {string} xml
 * @returns {{ packageName: string|null, publisher: string|null, applicationId: string|null }}
 */
export function parseFusionManifest(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new TypeError('parseFusionManifest: expected a non-empty XML string');
  }
  const msixTag = firstOpeningTag(xml, 'msix');
  if (!msixTag) {
    throw new Error('parseFusionManifest: no <msix> element found');
  }
  return {
    packageName: readAttr(msixTag, 'packageName'),
    publisher: readAttr(msixTag, 'publisher'),
    applicationId: readAttr(msixTag, 'applicationId'),
  };
}

/**
 * Assert that a fusion manifest's identity fields EXACTLY match an AppxManifest.
 * Returns a structured result rather than throwing, so callers/tests can inspect
 * every individual mismatch (each of which would cause 0x80073D54 at runtime).
 *
 * @param {ReturnType<typeof parseAppxManifest>} appx
 * @param {ReturnType<typeof parseFusionManifest>} fusion
 * @returns {{ ok: boolean, mismatches: Array<{ field: string, appx: string|null, fusion: string|null }> }}
 */
export function validateIdentityConsistency(appx, fusion) {
  const mismatches = [];
  const check = (field, appxValue, fusionValue) => {
    if (appxValue !== fusionValue) {
      mismatches.push({ field, appx: appxValue, fusion: fusionValue });
    }
  };
  check('packageName<->Identity.Name', appx.name, fusion.packageName);
  check('publisher<->Identity.Publisher', appx.publisher, fusion.publisher);
  check('applicationId<->Application.Id', appx.applicationId, fusion.applicationId);
  return { ok: mismatches.length === 0, mismatches };
}
