import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhTW from 'antd/locale/zh_TW';
import Section3DPage from './pages/Section3D';
import { theme } from './ui/theme';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider theme={theme} locale={zhTW}>
      <App>
        <Section3DPage />
      </App>
    </ConfigProvider>
  </StrictMode>,
);
