import { ExternalLink } from 'lucide-react';
import { APP_INFO } from '../appInfo';
import { Logo } from './Logo';
import { Modal } from './ui';

/**
 * About Project Hub: product identity, version, creator attribution,
 * repository link, license state and third-party acknowledgements.
 *
 * Every value comes from appInfo.ts (version from package.json at build time).
 * Nothing here is fabricated: the license row reports the verified absence of a
 * LICENSE file, and the release row reports the development channel because no
 * release pipeline is configured.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const year = new Date().getFullYear();
  return (
    <Modal title={`About ${APP_INFO.name}`} onClose={onClose}>
      <div className="about">
        <div className="about-head">
          <Logo size={48} />
          <div>
            <div className="about-name">{APP_INFO.name}</div>
            <div className="about-tagline">{APP_INFO.tagline}</div>
          </div>
        </div>

        <p className="about-desc">{APP_INFO.description}</p>

        <dl className="kv about-meta">
          <dt>Version</dt>
          <dd>
            <span className="mono">v{APP_INFO.version}</span>
          </dd>
          <dt>Release</dt>
          <dd>
            Development build — no release channel is configured for this project yet.
          </dd>
          <dt>License</dt>
          <dd>
            {APP_INFO.license ? (
              APP_INFO.license
            ) : (
              <span className="dim">
                No software license has been declared in this repository. Until one is added, the code is
                not open source and all rights are reserved by the creator.
              </span>
            )}
          </dd>
          <dt>Created by</dt>
          <dd>
            <span>{APP_INFO.creator.displayName}</span>{' '}
            <a href={APP_INFO.creator.profileUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} /> GitHub profile
            </a>
          </dd>
          <dt>Source code</dt>
          <dd>
            <a href={APP_INFO.repositoryUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} /> {APP_INFO.repositoryUrl}
            </a>
          </dd>
        </dl>

        <div className="about-credits">
          <div className="about-credits-title">Built with open-source software</div>
          <div className="about-credits-list">
            {APP_INFO.credits.map(c => (
              <a key={c.name} href={c.url} target="_blank" rel="noopener noreferrer" title={c.role}>
                {c.name}
              </a>
            ))}
          </div>
          <div className="about-credits-note">
            Each project is licensed independently by its own authors; their names, logos and trademarks
            remain the property of their respective owners.
          </div>
        </div>

        <div className="about-foot">
          © {year} {APP_INFO.creator.displayName}. All rights reserved.
        </div>
      </div>
    </Modal>
  );
}
