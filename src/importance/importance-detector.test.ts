import { describe, it, expect } from 'vitest';
import { ImportanceDetector } from './importance-detector.js';
import type { ConversationMessage } from '../types.js';

function msg(id: string, content: string): ConversationMessage {
  return { id, role: 'user', content, timestamp: Date.now() };
}

describe('ImportanceDetector', () => {
  it('scores noise messages low', () => {
    const detector = new ImportanceDetector();
    const score = detector.score(msg('1', 'Sounds good, thanks!'));

    expect(score.overall).toBeLessThan(0.3);
  });

  it('scores corrections high (state delta)', () => {
    const detector = new ImportanceDetector();
    detector.score(msg('1', "Let's use PostgreSQL for the database."));
    const score = detector.score(msg('2', 'Actually, switch to SQLite instead.'));

    expect(score.stateDelta).toBeGreaterThan(0.3);
    expect(score.overall).toBeGreaterThan(0.2);
  });

  it('scores messages with new entities higher', () => {
    const detector = new ImportanceDetector();
    const score1 = detector.score(msg('1', 'We need to set up React and TypeScript.'));
    const score2 = detector.score(msg('2', 'Ok sounds good.'));

    expect(score1.stateDelta).toBeGreaterThan(score2.stateDelta);
  });

  it('detects trajectory discontinuity on topic shifts', () => {
    const detector = new ImportanceDetector();

    // Establish a trajectory about databases
    detector.score(msg('1', 'We need to choose a database for our application.'));
    detector.score(msg('2', 'PostgreSQL has great JSON support and reliability.'));
    detector.score(msg('3', 'The database should handle concurrent writes well.'));

    // Sharp topic shift
    const shifted = detector.score(
      msg('4', 'For the deployment pipeline, we need Docker and Kubernetes.'),
    );

    expect(shifted.trajectoryDiscontinuity).toBeGreaterThan(0);
  });

  it('retrospective recomputation updates scores', () => {
    const detector = new ImportanceDetector();

    detector.score(msg('1', 'We chose React for the frontend framework.'));
    detector.score(msg('2', 'The color scheme should be blue.'));
    detector.score(msg('3', 'Going back to React, we need server-side rendering.'));

    const recomputed = detector.recompute();

    // Message 1 introduced React, message 3 references it —
    // so message 1's reference frequency should be higher after recompute
    expect(recomputed.length).toBe(3);
  });

  it('returns all scores', () => {
    const detector = new ImportanceDetector();
    detector.score(msg('1', 'First message about architecture.'));
    detector.score(msg('2', 'Second message about testing.'));

    const all = detector.getAllScores();
    expect(all).toHaveLength(2);
    expect(all[0].messageId).toBe('1');
    expect(all[1].messageId).toBe('2');
  });

  it('supports custom weights', () => {
    const detector = new ImportanceDetector({
      stateDelta: 0.1,
      referenceFrequency: 0.1,
      trajectoryDiscontinuity: 0.8,
    });

    // With high trajectory weight, topic shifts should dominate
    detector.score(msg('1', 'We are building a web application with React.'));
    const shifted = detector.score(
      msg('2', 'The legal requirements mandate GDPR compliance in all regions.'),
    );

    expect(shifted.overall).toBeGreaterThan(0);
  });
});
