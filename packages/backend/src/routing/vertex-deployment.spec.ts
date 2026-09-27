import {
  formatVertexDeployment,
  getVertexBaseUrl,
  parseVertexDeployment,
} from './vertex-deployment';

describe('parseVertexDeployment', () => {
  it('parses project/location', () => {
    expect(parseVertexDeployment('my-project-123/us-central1')).toEqual({
      project: 'my-project-123',
      location: 'us-central1',
    });
  });

  it('treats an absent region as express mode', () => {
    expect(parseVertexDeployment(null)).toBeNull();
    expect(parseVertexDeployment(undefined)).toBeNull();
    expect(parseVertexDeployment('')).toBeNull();
  });

  it('falls back to express rather than building a broken URL', () => {
    // A lone location, a lone project, extra segments, and ids that cannot be
    // real Google Cloud projects all resolve to null.
    expect(parseVertexDeployment('us-central1')).toBeNull();
    expect(parseVertexDeployment('my-project/')).toBeNull();
    expect(parseVertexDeployment('my-project/us-central1/extra')).toBeNull();
    expect(parseVertexDeployment('My-Project/us-central1')).toBeNull();
    expect(parseVertexDeployment('ab/us-central1')).toBeNull();
    expect(parseVertexDeployment('my-project/not a region')).toBeNull();
  });

  it('accepts multi-digit region numbers', () => {
    // europe-west12 is a real location; a single-digit pattern silently
    // demoted such connections back to express mode.
    expect(parseVertexDeployment('my-project/europe-west12')).toEqual({
      project: 'my-project',
      location: 'europe-west12',
    });
  });

  it('accepts the global location', () => {
    expect(parseVertexDeployment('my-project/global')).toEqual({
      project: 'my-project',
      location: 'global',
    });
  });

  it('round-trips through formatVertexDeployment', () => {
    const region = 'my-project/europe-west4';
    expect(formatVertexDeployment(parseVertexDeployment(region)!)).toBe(region);
  });
});

describe('getVertexBaseUrl', () => {
  it('uses the regional host for a regional location', () => {
    expect(getVertexBaseUrl({ project: 'p1', location: 'us-central1' })).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1',
    );
  });

  it('uses the unprefixed host for the global location', () => {
    expect(getVertexBaseUrl({ project: 'p1', location: 'global' })).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/global',
    );
  });
});
