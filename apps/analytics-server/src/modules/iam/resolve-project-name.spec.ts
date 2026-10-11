import { resolveProjectName } from '../../common/interceptors/project.interceptor';

describe('resolveProjectName', () => {
  it('defaults to clklogapp when the header is missing', () => {
    expect(resolveProjectName({ headers: {}, query: {}, body: undefined })).toBe('clklogapp');
  });

  it('uses the first header value when Express gives an array', () => {
    expect(
      resolveProjectName({
        headers: { 'x-project-name': ['clklogapp', 'other'] },
        query: {},
        body: undefined,
      }),
    ).toBe('clklogapp');
  });

  it('does not remap an explicit default project', () => {
    expect(
      resolveProjectName({
        headers: { 'x-project-name': 'default' },
        query: {},
        body: undefined,
      }),
    ).toBe('default');
  });
});
