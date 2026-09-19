"""Relational-contract tests ONLY. This stdlib SQLite connection is not encrypted."""
import pathlib
import sqlite3
import unittest

SCHEMA = pathlib.Path(__file__).parents[1] / 'schema' / 'semantic-v1.sql'

class SchemaContract(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA.read_text())
        self.db.execute("INSERT INTO index_config VALUES (1,1,'space','hash',2,'cosine','l2','text-v1','chunk-v1')")
        self.db.execute("INSERT INTO note_state(note_id,generation,state) VALUES (?,1,'pending')", ('a'*32,))
        self.db.commit()

    def chunk(self, dimensions=2, vector=bytes(8), generation=1):
        self.db.execute('INSERT INTO chunks VALUES (?,?,0,0,2,?,?,?,NULL)',
                        (generation, 'a'*32, 'hash', dimensions, vector))

    def test_dimension_and_generation_contract(self):
        self.chunk()
        self.db.commit()
        self.db.execute('DELETE FROM chunks')
        with self.assertRaises(sqlite3.IntegrityError):
            self.chunk(vector=bytes(4))
        with self.assertRaises(sqlite3.IntegrityError):
            self.chunk(dimensions=3, vector=bytes(12))
        with self.assertRaises(sqlite3.IntegrityError):
            self.chunk(generation=2)

    def test_single_active_configuration_and_cascade(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO index_config VALUES (2,2,'s','h',2,'cosine','l2','v','v')")
        self.chunk()
        self.db.execute('DELETE FROM note_state')
        self.assertEqual(self.db.execute('SELECT count(*) FROM chunks').fetchone()[0], 0)

    def test_transaction_rolls_back_chunk_replacement_and_state(self):
        self.chunk()
        self.db.execute("UPDATE note_state SET state='indexed'")
        self.db.commit()
        try:
            with self.db:
                self.db.execute('DELETE FROM chunks')
                self.db.execute("UPDATE note_state SET state='pending'")
                self.chunk(vector=bytes(4))
        except sqlite3.IntegrityError:
            pass
        self.assertEqual(self.db.execute('SELECT count(*) FROM chunks').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT state FROM note_state').fetchone()[0], 'indexed')

if __name__ == '__main__':
    unittest.main()
