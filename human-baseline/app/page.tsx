'use client';

import { useState } from 'react';

export default function Home() {
  const [started, setStarted] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);

  if (!started) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '20px' }}>
          Ethical Reasoning Study
        </h1>
        <p style={{ fontSize: '1.1rem', lineHeight: 1.6, maxWidth: '600px', margin: '0 auto 30px' }}>
          This study examines how people perceive and distinguish ethical scenarios.
          You will be shown groups of 3 ethical scenarios and asked to identify
          similarities and differences between them.
        </p>
        <p style={{ color: '#666', marginBottom: '30px' }}>
          Estimated time: 15-20 minutes | 5-10 comparison tasks
        </p>

        <div style={{
          background: '#fff',
          border: '1px solid #ddd',
          borderRadius: '8px',
          padding: '20px',
          maxWidth: '600px',
          margin: '0 auto 20px',
          textAlign: 'left',
        }}>
          <h3 style={{ marginBottom: '10px' }}>Consent</h3>
          <p style={{ fontSize: '0.9rem', color: '#555', marginBottom: '15px' }}>
            Your responses will be used for research purposes only. No personally
            identifiable information is collected. Your data will help establish
            baseline measures of human consistency in ethical reasoning, which will
            be compared against AI model outputs. You may stop at any time.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(e) => setConsentGiven(e.target.checked)}
            />
            I understand and consent to participate
          </label>
        </div>

        <button
          onClick={() => setStarted(true)}
          disabled={!consentGiven}
          style={{
            padding: '12px 40px',
            fontSize: '1.1rem',
            background: consentGiven ? '#2196F3' : '#ccc',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: consentGiven ? 'pointer' : 'not-allowed',
          }}
        >
          Begin Study
        </button>
      </div>
    );
  }

  // Redirect to survey page
  if (typeof window !== 'undefined') {
    window.location.href = '/survey';
  }

  return <p>Loading survey...</p>;
}
