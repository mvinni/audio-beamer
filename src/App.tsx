import './App.css';
import PeerView from './PeerView';

import Container from 'react-bootstrap/Container';

function App() {
  return (
    <Container className="App">
      <header className="App-header">
        <p>
          Sound Beamer
        </p>
      </header>
      <PeerView />
    </Container>
  );
}

export default App;
