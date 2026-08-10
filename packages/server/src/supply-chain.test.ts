import { describe, it, expect } from 'vitest';
import { generateSBOM } from 'pledgestack-server';

describe('Supply Chain / SBOM (#22)', () => {
  it('generates a CycloneDX SBOM', () => {
    const sbom = generateSBOM('/test', 'cyclonedx');
    expect(sbom).toBeDefined();
    expect(sbom.bomFormat).toBe('cyclonedx');
  });

  it('generates an SPDX SBOM', () => {
    const sbom = generateSBOM('/test', 'spdx');
    expect(sbom).toBeDefined();
    expect(sbom.bomFormat).toBe('spdx');
  });

  it('includes components list', () => {
    const sbom = generateSBOM('/test');
    expect(Array.isArray(sbom.components)).toBe(true);
  });

  it('includes spec version', () => {
    const sbom = generateSBOM('/test');
    expect(sbom.specVersion).toBeDefined();
  });
});
