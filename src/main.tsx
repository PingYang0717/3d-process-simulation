import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import Section3DPage from './pages/Section3D';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <App>
        <Section3DPage />
      </App>
    </ConfigProvider>
  </StrictMode>,
);
