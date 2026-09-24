'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRoadmap, profileReady, needsTwelveYears } = require('../roadmap');

function taskById(roadmap, id) {
  for (const stage of roadmap) {
    const task = stage.tasks.find((item) => item.id === id);
    if (task) return task;
  }
  return null;
}

test('incomplete profile suppresses concrete dates and future actions', () => {
  const roadmap = buildRoadmap(null, {}, 2027);
  const profile = taskById(roadmap, 'profile');
  const shortlist = taskById(roadmap, 'shortlist');
  assert.equal(profile.available, true);
  assert.equal(shortlist.available, false);
  assert.equal(shortlist.deadline, null);
  assert.equal(shortlist.timingLabel, 'Сначала закончи настройку маршрута');
});

test('11-class profile selects exactly one 12-year path and delays diploma documents', () => {
  const profile = {
    education: '11 классов',
    goal: 'Бакалавриат',
    budget: 'Только со стипендией',
    educationPath: 'foundation',
  };
  assert.equal(profileReady(profile), true);
  assert.equal(needsTwelveYears(profile), true);

  const roadmap = buildRoadmap(null, profile, 2027);
  assert.ok(taskById(roadmap, 'foundation12'));
  assert.equal(taskById(roadmap, 'enroll12'), null);

  const apostille = taskById(roadmap, 'apostille');
  assert.equal(apostille.available, false);
  assert.equal(apostille.deadline, null);
  assert.equal(apostille.timingLabel, 'После получения аттестата');
});

test('12-year education removes the extra-year stage and enables document timing', () => {
  const profile = {
    education: 'НИШ / 12 лет',
    goal: 'Бакалавриат',
    budget: 'До 3 млн ₸/год',
  };
  const roadmap = buildRoadmap(null, profile, 2027);
  assert.equal(roadmap.some((stage) => stage.id === 'education12'), false);
  const apostille = taskById(roadmap, 'apostille');
  assert.equal(apostille.available, true);
  assert.equal(apostille.deadline, '2027-01-31');
  assert.equal(apostille.deadlineKind, 'Ориентир');
});
